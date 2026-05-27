// Host worker — DedicatedWorker entry.
//
// This is the worker where user JS, Node lib/*.js, and emnapi context
// will live after the L5 cutover.  For L2, it just runs the RPC server
// and replies to `ping`.
//
// Bootstrap protocol (page → host worker):
//   1. Page spawns `new Worker(this file, { type: 'module' })`.
//   2. Page posts `{ kind: 'init', requestSab, replySab, hostWorkerId }`.
//      requestSab/replySab are SAB-backed sab-rings already allocated by
//      the page.  The wasm worker has the same SABs (handed to it
//      independently); pages bridges them via the SABs themselves —
//      after the init handshake, no postMessage traffic is needed for
//      RPC.
//   3. Host worker attaches to both rings, starts the RPC server.
//   4. Host worker posts `{ kind: 'ready' }` back to page.
//
// After ready, the page treats this host worker as "the host" and the
// wasm worker as "the wasm".  RPC flows over the SABs directly.

import {
  attachRing,
  RingView,
} from "../wasi-shim/sab-ring";
import { RpcServer } from "./rpc-server";
import { attachIpcStructuredPort as attachStructuredPort } from "./ipc-structured-port";
import {
  buildExecutorContext,
  type ChildProcExecResult,
  type ExecutorEventSource,
} from "./executor-context";
import { RpcClient } from "./rpc-client";
import { SyncRpcClient } from "./rpc-client-sync";
import {
  OP_PING,
  OP_HOST_READY,
  OP_HOST_ECHO,
  OP_RUN_USER_SCRIPT,
  OP_NAPI_GET_UNDEFINED,
  OP_NAPI_GET_NULL,
  OP_NAPI_GET_GLOBAL,
  OP_NAPI_OPEN_HANDLE_SCOPE,
  OP_NAPI_CLOSE_HANDLE_SCOPE,
  OP_NAPI_DEBUG_HANDLE_STORE_SIZE,
  OP_SUBTLE_DIGEST,
  OP_SUBTLE_HMAC,
  OP_SUBTLE_DIGEST_VIA_NAPI_MEM,
  OP_SUBTLE_HMAC_VIA_NAPI_MEM,
  OP_SPAWN_USER_WORKER,
  OP_DELIVER_USER_WORKER_EXIT,
  OP_WORKER_POST_MESSAGE_TO_CHILD,
  OP_WORKER_POST_MESSAGE_TO_PARENT,
  OP_DELIVER_MESSAGE_TO_CHILD,
  OP_DELIVER_MESSAGE_FROM_CHILD,
  OP_RUN_CHILD_PROCESS,
  OP_SPAWN_ASYNC_START,
  OP_SPAWN_ASYNC_KILL,
  OP_SPAWN_STDIO_WRITE,
  OP_SPAWN_STDIO_END,
  OP_SPAWN_IPC_SEND,
  OP_SPAWN_IPC_DISCONNECT,
  OP_SPAWN_ASYNC_EVENT,
  DIGEST_STAGING_OFFSET,
  REPLY_STATUS_OK,
  REPLY_STATUS_HOST_ERROR,
  REPLY_STATUS_INVALID_ARGS,
  HOST_RPC_RING_CONFIG,
  ASYNC_EVENT_KIND as EK,
} from "./rpc-protocol";

// E22: napi handle bump allocator must stay below DIGEST_STAGING_OFFSET
// so the digest staging region (used by OP_SUBTLE_DIGEST_VIA_NAPI_MEM)
// isn't trampled.
const POOL_ALLOC_CEILING = DIGEST_STAGING_OFFSET;
// F-1: emnapi context on host worker.  Imports via the project facade
// (single swap point for v1 vs v2 — see plans/lever-b-l5-options.md
// "v1 vs v2" finding).
import { createContext, createNapiModule } from "../napi-host/emnapi";
// F-4: bulk-register read-only napi op handlers.
import { makeNapiOpRegistry } from "./napi-op-handlers";

declare const self: DedicatedWorkerGlobalScope;

// R10 multi-context hypothesis verification — one-line module-load
// counter.  If this logs ">1", host-worker.ts is being instantiated
// multiple times (Vite HMR, bridge-ready re-fire, worker spawn race).
// That would mean multiple emnapi contexts exist, and the factory's
// captured napiFn reference may be bound to a stale wasmMemory while
// our SAB-based reads target the current one — explaining the silent
// write bug for create_array_with_length / create_string_utf8.  See
// experiments/r10-emnapi-silent-write/FINDINGS.md.
{
  const g = globalThis as { __edgeHostModuleLoadCount?: number };
  g.__edgeHostModuleLoadCount = (g.__edgeHostModuleLoadCount ?? 0) + 1;
  self.postMessage({
    kind: "host-log",
    text: `[host-worker:?] MODULE LOAD #${g.__edgeHostModuleLoadCount}`,
    level: "info",
  });
}

// Single source of truth in rpc-protocol.ts; re-aliased locally for
// the file-local sites that already call it RING_CONFIG.
const RING_CONFIG = HOST_RPC_RING_CONFIG;

interface InitMessage {
  kind: "init";
  requestSab: SharedArrayBuffer;
  replySab: SharedArrayBuffer;
  reverseRequestSab: SharedArrayBuffer;
  reverseReplySab: SharedArrayBuffer;
  sharedWakeSab: SharedArrayBuffer;
  hostWorkerId: number;
  /** Optional JS source eval'd in this worker's globalThis after init
   *  but before ready. Used to install per-host-worker hooks (notably
   *  __edgeChildProcessExecutor for the child-process-via-executor
   *  policy's async path). */
  bootScript?: string;
}

interface ReadyMessage {
  kind: "ready";
  hostWorkerId: number;
  /** F-1: SAB backing the host's napi memory.  Probe code can use
   *  this to verify napi handlers wrote handles at the expected ptr. */
  napiMemorySab?: SharedArrayBuffer;
}

interface ReverseEchoMessage {
  kind: "reverse-echo";
  bytes: number;
}

let hostWorkerId = -1;
let requestRing: RingView | null = null;
let replyRing: RingView | null = null;
let server: RpcServer | null = null;
// Reverse channel: host-side client for sending requests TO wasm
// (finalizers, threadsafe function dispatch, future host→wasm signals).
let reverseRequestRing: RingView | null = null;
let reverseReplyRing: RingView | null = null;
let reverseClient: RpcClient | null = null;
/** Exposed for L4 bench script and future L5 callers. */
export function getReverseClient(): RpcClient | null { return reverseClient; }

// F-9 path-a: sync variant of the reverse-channel client.  Used by
// callback-arg napi op handlers (napi_create_function etc.) — their
// closures need to invoke wasm funcrefs synchronously because emnapi's
// `withScope` wrapper does NOT await.  Lives alongside the async
// `reverseClient` on the same rings; only the wait strategy differs.
let hostSideReverseSyncClient: SyncRpcClient | null = null;
/** Exposed so callback-arg op handlers (registered in F-9 batch 4)
 *  can construct host-side closures via makeHostSideCallbackClosure. */
export function getHostSideReverseSyncClient(): SyncRpcClient | null {
  return hostSideReverseSyncClient;
}

// F-1: emnapi state.  Initialized lazily on first napi op so we don't
// pay the cost when only ping/echo are used.  Memory is the SAB shared
// with the wasm worker — wired in F-2.  For F-1 we use a host-local
// memory so we can probe the napi handlers end-to-end without needing
// the real wasm bridging.
let napiCtx: ReturnType<typeof createContext> | null = null;
let napiModuleHost: ReturnType<typeof createNapiModule> | null = null;
let napiHostMemory: WebAssembly.Memory | null = null;
/** Exposed so callback-arg op handlers (registered via napi-op-handlers.ts)
 *  can mint napi_values for host-side JS closures via
 *  `napiCtx.addToCurrentScope(closure).id`.  F-9 batch 4: napi_create_function
 *  + napi_define_class substitute the wasm-side funcref with a JS closure
 *  built by makeHostSideCallbackClosure; that closure needs a stable
 *  napi_value the wasm caller can later napi_call_function against. */
export function getNapiContext(): ReturnType<typeof createContext> | null {
  return napiCtx;
}
/** Exposed for callback-arg op handlers that need to write result handles
 *  to wasm memory at the caller-supplied resultPtr. */
export function getNapiHostMemory(): WebAssembly.Memory | null {
  return napiHostMemory;
}
function ensureNapiContext(): void {
  if (napiCtx) return;
  napiCtx = createContext();
  // F-1: stub instance.  F-2 replaces with the real shared memory.
  // E22: initial bumped from 1 to 4 pages (64 KiB → 256 KiB) so the
  // top half can host the digest staging region (DIGEST_STAGING_OFFSET
  // = 128 KiB) while leaving 112 KiB of headroom for the napi handle
  // bump allocator (16 KiB reserve + ~96 KiB usable).  maximum left at
  // 16 pages (1 MiB) so future growth is still possible if needed.
  napiHostMemory = new WebAssembly.Memory({ initial: 4, maximum: 16, shared: true });
  const wasmModule = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ]));
  const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
  let poolNext = 16384; // 16KB; below this is "reserved" for napi result writes
  const stubInstance = {
    exports: {
      memory: napiHostMemory,
      malloc: (size: number) => {
        // Q1 resolution: host-side bump allocator
        const ptr = poolNext;
        const newNext = poolNext + ((size + 7) & ~7);
        if (newNext > POOL_ALLOC_CEILING) {
          // Would collide with the digest staging region (E22).  Real
          // production would either expand napi memory or move staging
          // higher; for the current workload mix the pool stays well
          // under 96 KiB.
          log(
            `napi malloc(${size}) would exceed POOL_ALLOC_CEILING ${POOL_ALLOC_CEILING}; bumping anyway (debt)`,
            "warn",
          );
        }
        poolNext = newNext;
        return ptr;
      },
      free: () => {},
      __indirect_function_table: table,
      emnapi_create_env: () => 1, // env id 1
      emnapi_delete_env: () => 0,
      emnapi_runtime_init: () => {},
      emnapi_runtime_finalize: () => {},
      napi_register_wasm_v1: () => 0,
    },
  };
  napiModuleHost = createNapiModule({
    context: napiCtx,
    childThread: false,
    asyncWorkPoolSize: 0,
  });
  napiModuleHost.init({
    instance: stubInstance as unknown as WebAssembly.Instance,
    module: wasmModule,
    memory: napiHostMemory,
    table,
  });
  // R9 + DIAG-confirmed fix: napiModule.init() opens then closes its
  // internal scope, leaving root scope with handleStore=null.  All
  // handle-allocating napi ops then throw on `handleStore.push`.  Open
  // a long-lived scope here so handle-allocating ops work.  See
  // experiments/r9-host-emnapi-init/FINDINGS.md + the DIAG run in
  // host-worker.ts history (5/10 ops pass after this; up from 1/9).
  //
  // #!~debt host-emnapi-root-scope-accumulates: scope never closed.
  // Production-clean version opens/closes per-RPC via factory wrappers.
  const napi = napiModuleHost.imports.napi as Record<string, (...a: number[]) => number>;
  const napiOpenHandleScope = napi.napi_open_handle_scope;
  if (typeof napiOpenHandleScope === "function") {
    const SCOPE_OUT_PTR = 1020;
    try {
      const status = napiOpenHandleScope(1, SCOPE_OUT_PTR);
      if (status !== 0) log(`napi_open_handle_scope status=${status}`, "warn");
    } catch (e) {
      log(`napi_open_handle_scope threw: ${(e as Error).message}`, "warn");
    }
  }
  log(`napi context ready; ${Object.keys(napi).length} napi fns available`);
}

function log(text: string, level: "info" | "warn" | "err" = "info"): void {
  self.postMessage({ kind: "host-log", text: `[host-worker:${hostWorkerId}] ${text}`, level });
}

// ── Worker-threads phase 1: spawn-user-worker plumbing ─────────────
//
// The host worker doesn't spawn user-worker pairs directly — Web Worker
// construction needs page-thread privileges (and main is where the
// shared compiled WebAssembly.Module + the userWorkers registry live,
// per docs/worker-threads-design.md).  We postMessage main with a
// spawn request and await its reply.
//
// Path B (chosen) — see docs/worker-threads-design.md:
//   wasm → globalThis.__edgeSpawnNodeWorker (sync RPC)
//        → here (OP_SPAWN_USER_WORKER handler)
//        → postMessage main {kind:'spawn-user-worker', requestId, ...}
//        → main spawns the pair, replies {kind:'spawn-user-worker-reply', requestId, workerId}
//        → here resolves the pending promise
//        → returns workerId to wasm

interface PendingSpawn {
  resolve: (workerId: number) => void;
  reject: (err: Error) => void;
}

const pendingSpawns = new Map<number, PendingSpawn>();
let nextSpawnRequestId = 1;

function postToMainAndAwaitSpawn(bootstrapScript: string, workerData: Uint8Array): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const requestId = nextSpawnRequestId++;
    pendingSpawns.set(requestId, { resolve, reject });
    self.postMessage({
      kind: "spawn-user-worker",
      requestId,
      parentHostWorkerId: hostWorkerId,
      bootstrapScript,
      // structuredClone-able by postMessage; main reuses the bytes when
      // forwarding to the child wasm at bootstrap time.
      workerData,
    });
    // No timeout intentionally — spawn is async-on-main and may take
    // 100-300ms for the child wasm to instantiate (per E24 + edge boot).
    // If main never replies, the wasm thread blocks on Atomics.wait
    // forever, which surfaces as an obvious hang in dev (good).
  });
}

// Called by the main-message listener when main replies to a pending
// spawn request OR delivers an exit event for a previously-spawned child.
function handleMainSpawnReply(data: { requestId: number; workerId?: number; error?: string }): void {
  const pending = pendingSpawns.get(data.requestId);
  if (!pending) {
    log(`spawn-user-worker-reply: no pending request for id=${data.requestId}`, "warn");
    return;
  }
  pendingSpawns.delete(data.requestId);
  if (data.error) {
    pending.reject(new Error(data.error));
  } else if (typeof data.workerId === "number") {
    pending.resolve(data.workerId);
  } else {
    pending.reject(new Error("spawn-user-worker-reply: missing workerId and error"));
  }
}

// child-process-via-executor (async path). Runs the user-installed
// executor IN THIS HOST WORKER (not on main -- main has zero runtime
// responsibility per the architecture rule). The executor is installed
// via the host-worker init bootScript (see InitMessage.bootScript).
//
// Wasm worker's spawnSync routes here via OP_RUN_CHILD_PROCESS sync
// RPC. We invoke the executor (sync OR async), await, serialize result,
// return. Wasm side blocks on Atomics.wait the entire time -- host
// worker's event loop stays free because it's a separate thread.
//
// Result shape matches the wasm-side patch's parser in
// child-process-via-executor.ts; canonical definition lives in
// executor-context.ts and is imported above.
type ChildProcExecutor = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => ChildProcExecResult | Promise<ChildProcExecResult>;

// Binary frame format (see child-process-via-executor.ts for wire docs).
function unpackChildProcRequest(buf: Uint8Array): {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  killSignal?: string;
  input?: Uint8Array;
  ipc?: boolean;
  ipcAdvanced?: boolean;
  killable?: "hard";
} | null {
  if (buf.byteLength < 8) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = dv.getUint32(0, true);
  if (4 + headerLen + 4 > buf.byteLength) return null;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder("utf-8").decode(
      buf.subarray(4, 4 + headerLen),
    )) as Record<string, unknown>;
  } catch { return null; }
  const inputLen = dv.getUint32(4 + headerLen, true);
  const inputStart = 4 + headerLen + 4;
  if (inputStart + inputLen > buf.byteLength) return null;
  let input: Uint8Array | undefined;
  if (inputLen > 0) {
    input = new Uint8Array(inputLen);
    input.set(buf.subarray(inputStart, inputStart + inputLen));
  }
  return {
    command: String(header.command ?? ""),
    args: Array.isArray(header.args) ? header.args.map(String) : [],
    env: (header.env && typeof header.env === "object")
      ? header.env as Record<string, string>
      : undefined,
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    timeout: typeof header.timeout === "number" ? header.timeout : undefined,
    killSignal: typeof header.killSignal === "string" ? header.killSignal : undefined,
    input,
    ipc: header.ipc === true,
    ipcAdvanced: header.ipcAdvanced === true,
    killable: header.killable === "hard" ? "hard" : undefined,
  };
}

function packChildProcReply(result: ChildProcExecResult | { __noExecutor: true }): Uint8Array {
  if ("__noExecutor" in result) {
    const headerBytes = new TextEncoder().encode(JSON.stringify({ __noExecutor: true }));
    const buf = new Uint8Array(4 + headerBytes.byteLength + 8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, headerBytes.byteLength, true);
    buf.set(headerBytes, 4);
    dv.setUint32(4 + headerBytes.byteLength, 0, true);
    dv.setUint32(4 + headerBytes.byteLength + 4, 0, true);
    return buf;
  }
  const toBytes = (v: Uint8Array | string | number[] | undefined): Uint8Array => {
    if (v == null) return new Uint8Array(0);
    if (v instanceof Uint8Array) return v;
    if (typeof v === "string") return new TextEncoder().encode(v);
    if (Array.isArray(v)) return new Uint8Array(v);
    return new TextEncoder().encode(String(v));
  };
  const stdoutBytes = toBytes(result.stdout);
  const stderrBytes = toBytes(result.stderr);
  const header = {
    code: typeof result.code === "number" ? result.code : null,
    signal: result.signal != null ? result.signal : null,
    error: result.error || null,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const buf = new Uint8Array(4 + headerBytes.byteLength + 4 + stdoutBytes.byteLength + 4 + stderrBytes.byteLength);
  const dv = new DataView(buf.buffer);
  let off = 0;
  dv.setUint32(off, headerBytes.byteLength, true); off += 4;
  buf.set(headerBytes, off); off += headerBytes.byteLength;
  dv.setUint32(off, stdoutBytes.byteLength, true); off += 4;
  buf.set(stdoutBytes, off); off += stdoutBytes.byteLength;
  dv.setUint32(off, stderrBytes.byteLength, true); off += 4;
  buf.set(stderrBytes, off);
  return buf;
}

// =================================================================
// Async child_process spawn() / exec() / execFile() machinery.
//
// Each START call invokes the executor (sync or async) and registers
// a long-lived child handle. Events (stdout/stderr chunks, exit) get
// pushed to wasm via reverse-RPC OP_SPAWN_ASYNC_EVENT. KILL sends an
// abort signal that the executor can cooperate with (via opts.signal).
//
// Executor protocol for async spawn (extends the sync executor shape):
//   - Returns Promise<ExecResult> (single-chunk delivery)
//   - OR returns { onStdout, onStderr, exit, kill } object for true
//     streaming (P3.1; not in MVP -- current build delivers result
//     as a single chunk on exit).
// =================================================================

interface SpawnAsyncChild {
  childId: number;
  abortController: AbortController;
  done: boolean;
  // ExecutorEventSource owns the per-fd pipes + IPC handler list; RPC
  // handlers route inbound STDIO_WRITE/IPC_SEND through this surface,
  // ipcStructuredHandlers fans wasm->executor messages through it too.
  // Shared implementation lives in executor-context.ts.
  source: ExecutorEventSource;
  ipcEnabled: boolean;
  ipcAdvanced: boolean;
}

// P3.9: structured-clone IPC port (one half of a MessageChannel between
// host and wasm-runtime). Routes per-childId messages with full V8
// postMessage fidelity. Activates only for serialization: 'advanced'
// spawns; json-mode spawns keep using the byte-stream RPC path.
// Protocol implementation lives in ipc-structured-port.ts -- shared
// with the wasm-runtime side which uses the symmetric setup.
let cachedBootScript: string | null = null;

// P4.3 hard-kill: per-childId Worker registry. terminate() halts JS
// even in tight loops, the only way browsers let us forcibly stop
// running code. The ipcEnabled flag tracks whether the wasm-side
// EdgePipe IPC routes through to the runner (set at spawn time, flipped
// false on either-side disconnect so subsequent IPC RPCs become no-ops).
// ipcAdvanced selects the encoding when routing executor->wasm messages:
// structured-clone via the existing host<->wasm port (full V8 fidelity)
// or JSON via EK.IPC_MESSAGE byte events (Node's json mode).
type HardKillHandle = { worker: Worker; ipcEnabled: boolean; ipcAdvanced: boolean };
const hardKillRunners = new Map<number, HardKillHandle>();

function startHardKillableSpawn(
  childId: number,
  req: NonNullable<ReturnType<typeof unpackChildProcRequest>>,
): Uint8Array {
  if (!cachedBootScript) {
    log("hard-kill spawn requested but no cachedBootScript", "warn");
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0, true);
    dv.setInt32(4, -38, true);
    return buf;
  }
  // Match probe pattern: URL to a const, static name, sniff vite quirks
  const runnerUrl = new URL("./killable-executor-runner.ts", import.meta.url);
  const worker = new Worker(runnerUrl, { type: "module", name: "edge-killable-exec" });
  const wantsAdvancedIpc = req.ipc === true && req.ipcAdvanced === true;
  const handle: HardKillHandle = {
    worker,
    ipcEnabled: req.ipc === true,
    ipcAdvanced: wantsAdvancedIpc,
  };
  hardKillRunners.set(childId, handle);
  // Advanced (structured-clone) IPC on the killable path: register a
  // per-childId inbound handler that forwards wasm->runner messages
  // through the runner's main channel (Worker.postMessage already runs
  // the structured-clone algorithm, so Map/Set/Date/ArrayBuffer/cycles
  // preserve without a separate MessageChannel). Outbound runner->wasm
  // routes through sendIpcStructuredMessage in the runner-message handler.
  if (wantsAdvancedIpc) {
    ipcStructuredHandlers.set(childId, (msg) => {
      if (!handle.ipcEnabled) return;
      worker.postMessage({ kind: "ipc-msg", msg });
    });
  }
  worker.addEventListener("message", (e: MessageEvent) => {
    const reply = e.data as {
      kind?: string;
      bytes?: Uint8Array;
      fd?: number;
      msg?: unknown;
      code?: number | null;
      signal?: string | null;
      error?: { code: string; message: string };
      finalStdout?: Uint8Array;
      finalStderr?: Uint8Array;
    };
    if (!reply || typeof reply.kind !== "string") return;
    if (reply.kind === "stdout") {
      if (reply.bytes && reply.bytes.byteLength > 0) emitChunked(childId, EK.STDOUT, reply.bytes);
      return;
    }
    if (reply.kind === "stderr") {
      if (reply.bytes && reply.bytes.byteLength > 0) emitChunked(childId, EK.STDERR, reply.bytes);
      return;
    }
    if (reply.kind === "stdio-out") {
      // Frame as [u32 fdIndex][bytes] to match the EK.STDIO_FDN wire
      // format the wasm side already parses (see EdgeProcess._handleEvent
      // STDIO_FDN branch). Zero-byte payload = end-of-stream signal.
      const fdIdx = typeof reply.fd === "number" ? reply.fd : 0;
      const bytes = reply.bytes || new Uint8Array(0);
      const payload = new Uint8Array(4 + bytes.byteLength);
      new DataView(payload.buffer).setUint32(0, fdIdx, true);
      if (bytes.byteLength > 0) payload.set(bytes, 4);
      emitAsyncEvent(childId, EK.STDIO_FDN, payload);
      return;
    }
    if (reply.kind === "ipc-msg") {
      if (!handle.ipcEnabled) return;
      if (handle.ipcAdvanced) {
        // Full structured-clone over the existing host<->wasm port.
        sendIpcStructuredMessage(childId, reply.msg);
      } else {
        let json: string;
        try { json = JSON.stringify(reply.msg ?? null); }
        catch (_e) { void _e; return; } // unserializable; drop like Node does
        emitAsyncEvent(childId, EK.IPC_MESSAGE, new TextEncoder().encode(json));
      }
      return;
    }
    if (reply.kind === "ipc-disconnect") {
      if (!handle.ipcEnabled) return;
      handle.ipcEnabled = false;
      if (handle.ipcAdvanced) {
        sendIpcStructuredDisconnect(childId);
        ipcStructuredHandlers.delete(childId);
      } else {
        emitAsyncEvent(childId, EK.IPC_DISCONNECT, new Uint8Array(0));
      }
      return;
    }
    if (reply.kind === "done") {
      if (reply.finalStdout && reply.finalStdout.byteLength > 0) emitChunked(childId, EK.STDOUT, reply.finalStdout);
      if (reply.finalStderr && reply.finalStderr.byteLength > 0) emitChunked(childId, EK.STDERR, reply.finalStderr);
      if (reply.error) {
        const errJson = JSON.stringify({
          code: reply.error.code || "ESPAWN",
          message: reply.error.message || "executor error",
        });
        emitAsyncEvent(childId, EK.ERROR, new TextEncoder().encode(errJson));
      }
      emitAsyncEvent(childId, EK.EXIT, packExitPayload(
        typeof reply.code === "number" ? reply.code : 0,
        reply.signal || null,
      ));
      ipcStructuredHandlers.delete(childId);
      worker.terminate();
      hardKillRunners.delete(childId);
    }
  });
  worker.addEventListener("error", (e: ErrorEvent) => {
    log("[hard-kill] runner error: msg=" + e.message + " file=" + e.filename, "err");
    const errJson = JSON.stringify({ code: "EWORKER", message: e.message || "runner error" });
    emitAsyncEvent(childId, EK.ERROR, new TextEncoder().encode(errJson));
    emitAsyncEvent(childId, EK.EXIT, packExitPayload(1, null));
    ipcStructuredHandlers.delete(childId);
    worker.terminate();
    hardKillRunners.delete(childId);
  });
  queueMicrotask(() => {
    const pidBytes = new Uint8Array(4);
    new DataView(pidBytes.buffer).setUint32(0, childId, true);
    emitAsyncEvent(childId, EK.SPAWNED, pidBytes);
  });
  worker.postMessage({
    kind: "run",
    executorSrc: cachedBootScript,
    command: req.command,
    args: req.args,
    env: req.env,
    cwd: req.cwd,
    killSignal: req.killSignal,
    ipc: req.ipc === true,
    ipcAdvanced: wantsAdvancedIpc,
    initialStdin: req.input,
    initialStdinEnded: req.input != null && req.input.byteLength > 0,
  });
  const reply = new Uint8Array(8);
  const dv = new DataView(reply.buffer);
  dv.setUint32(0, childId, true);
  dv.setInt32(4, 0, true);
  return reply;
}

const ipcStructuredHandlers = new Map<number, (msg: unknown) => void>();
let ipcStructuredOutbound: { send: (childId: number, msg: unknown, transfer?: Transferable[]) => boolean; disconnect: (childId: number) => boolean } | null = null;
function attachIpcStructuredPort(port: MessagePort): void {
  if (ipcStructuredOutbound) {
    log("ipc-structured-port received twice; replacing", "warn");
  }
  ipcStructuredOutbound = attachStructuredPort(port, {
    onMessage(childId, msg) {
      const handler = ipcStructuredHandlers.get(childId);
      if (handler) handler(msg);
    },
    onDisconnect(childId) {
      const child = asyncSpawnChildren.get(childId);
      if (child && child.ipcEnabled) {
        child.ipcEnabled = false;
        ipcStructuredHandlers.delete(childId);
        child.source.pushIpcDisconnect();
      }
    },
  });
}
function sendIpcStructuredMessage(childId: number, msg: unknown, transfer?: Transferable[]): boolean {
  return ipcStructuredOutbound ? ipcStructuredOutbound.send(childId, msg, transfer) : false;
}
function sendIpcStructuredDisconnect(childId: number): void {
  if (ipcStructuredOutbound) ipcStructuredOutbound.disconnect(childId);
}

const asyncSpawnChildren = new Map<number, SpawnAsyncChild>();
let nextSpawnChildId = 1;

function packAsyncEvent(childId: number, kind: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(4 + 1 + payload.byteLength);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, childId, true);
  buf[4] = kind;
  buf.set(payload, 5);
  return buf;
}

function emitAsyncEvent(childId: number, kind: number, payload: Uint8Array): void {
  if (!reverseClient) {
    log(`spawn-async: reverseClient not attached, dropping event for childId=${childId}`, "warn");
    return;
  }
  const buf = packAsyncEvent(childId, kind, payload);
  void reverseClient.call(OP_SPAWN_ASYNC_EVENT, hostWorkerId, 0, buf)
    .catch((err) => log(`spawn-async event delivery failed: ${(err as Error).message}`, "warn"));
}

// Chunk size MUST be derived from the ring slot size, not a free
// constant. The OP_SPAWN_ASYNC_EVENT payload format is
// [u32 childId][u8 kind][N data bytes], framed inside the RPC slot
// (SLOT_HEADER_SIZE=16, REQUEST_HEADER_SIZE=8). Anything larger than
// slot-capacity throws RangeError from payload.set() and -- because
// emitAsyncEvent is fire-and-forget -- the event is silently dropped.
// Pre-fix (16 KB chunks into 4 KB slots) lost any single stdout write
// over ~4 KB; regression covered by child-process-spawn-streaming-large.
const ASYNC_CHUNK_SIZE = RING_CONFIG.slotSize - 16 /*sab slot hdr*/ - 8 /*req hdr*/ - 5 /*event frame*/ - 8 /*safety*/;

function emitChunked(childId: number, kind: number, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) return;
  for (let off = 0; off < bytes.byteLength; off += ASYNC_CHUNK_SIZE) {
    const chunk = bytes.subarray(off, Math.min(off + ASYNC_CHUNK_SIZE, bytes.byteLength));
    emitAsyncEvent(childId, kind, chunk);
  }
}

function packExitPayload(code: number | null, signal: string | null): Uint8Array {
  const sigBytes = signal ? new TextEncoder().encode(signal) : new Uint8Array(0);
  const buf = new Uint8Array(4 + 4 + sigBytes.byteLength);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, code != null ? code : -1, true);
  dv.setUint32(4, sigBytes.byteLength, true);
  buf.set(sigBytes, 8);
  return buf;
}

// Default async fake-shell executor. Mirrors the wasm-side fake shell so
// async spawn() works without a user-installed executor (matches the sync
// path's fallback behavior). Resolves by command basename.
function defaultAsyncFakeShellExecutor(
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; input?: Uint8Array | string },
): ChildProcExecResult {
  const basename = (p: string): string => {
    const s = String(p || "");
    const i = s.lastIndexOf("/");
    return i < 0 ? s : s.slice(i + 1);
  };
  const name = basename(command);
  switch (name) {
    case "echo": {
      let noNewline = false;
      let i = 0;
      if (args[0] === "-n") { noNewline = true; i = 1; }
      const out = args.slice(i).join(" ");
      return { stdout: noNewline ? out : out + "\n", stderr: "", code: 0 };
    }
    case "true":
      return { stdout: "", stderr: "", code: 0 };
    case "false":
      return { stdout: "", stderr: "", code: 1 };
    case "cat": {
      const input = opts.input;
      if (input == null) return { stdout: "", stderr: "", code: 0 };
      if (input instanceof Uint8Array) return { stdout: input, stderr: "", code: 0 };
      return { stdout: String(input), stderr: "", code: 0 };
    }
    case "env": {
      const env = opts.env || {};
      const lines: string[] = [];
      for (const k in env) {
        if (Object.prototype.hasOwnProperty.call(env, k)) lines.push(k + "=" + env[k]);
      }
      return { stdout: lines.join("\n") + (lines.length ? "\n" : ""), stderr: "", code: 0 };
    }
    case "pwd":
      return { stdout: (opts.cwd || "/") + "\n", stderr: "", code: 0 };
    default:
      return {
        stdout: "",
        stderr: name + ": command not found\n",
        code: 127,
        signal: null,
        error: { code: "ENOENT", message: "spawn " + name + " ENOENT" },
      };
  }
}

async function startAsyncSpawn(requestBytes: Uint8Array): Promise<Uint8Array> {
  const req = unpackChildProcRequest(requestBytes);
  if (!req) {
    // Malformed -- reply with childId=0 + status=EINVAL
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0, true);
    dv.setInt32(4, -22, true); // EINVAL
    return buf;
  }
  const userExecutor = (self as unknown as { __edgeChildProcessExecutor?: ChildProcExecutor })
    .__edgeChildProcessExecutor;
  // Fall back to the default async fake shell when no user executor is
  // installed -- mirrors the sync path's fake-shell fallback so async
  // spawn() behaves the same way (echo/true/false/cat/env/pwd just work,
  // anything else returns ENOENT). Without this fallback the async API
  // would surface 'error' for every command on deployments that haven't
  // wired up a real executor.
  const executor: ChildProcExecutor = (typeof userExecutor === "function")
    ? userExecutor
    : (cmd, a, o) => defaultAsyncFakeShellExecutor(cmd, a, o as { env?: Record<string, string>; cwd?: string; input?: Uint8Array | string });

  const childId = nextSpawnChildId++;
  // P4.3 hard-kill path: opt-in via spawn option {killable: 'hard'}.
  // Runs the executor in a dedicated Worker that we can terminate()
  // to halt even uncooperative runaway loops. Trade-off: ~50ms spawn
  // latency. Streaming stdout/stderr, json-mode IPC, and streaming
  // stdin are routed through the runner worker (see startHardKillableSpawn).
  // Real value: in-browser test runners, AI code sandboxes, notebook
  // kernels -- anywhere we need "run code with a timeout".
  if (req.killable === "hard") {
    return startHardKillableSpawn(childId, req);
  }
  const ac = new AbortController();
  const wantsAdvancedIpc = req.ipc === true && req.ipcAdvanced === true;

  // Build the executor-facing opts via the shared context builder. The
  // sink encodes WHERE outbound bytes/messages go (reverse-RPC events
  // for the cooperative path); the source is what RPC handlers feed
  // into when wasm-side child.stdin.write() / .send() etc. arrive.
  const ctx = buildExecutorContext({
    sink: {
      stdout(bytes) { emitChunked(childId, EK.STDOUT, bytes); },
      stderr(bytes) { emitChunked(childId, EK.STDERR, bytes); },
      stdioOut(fd, bytes, _end) {
        // Frame as [u32 fdIndex][bytes]; zero-length payload = EOF.
        const payload = new Uint8Array(4 + bytes.byteLength);
        new DataView(payload.buffer).setUint32(0, fd, true);
        if (bytes.byteLength > 0) payload.set(bytes, 4);
        emitAsyncEvent(childId, EK.STDIO_FDN, payload);
      },
      ipcSend(msg) {
        if (wantsAdvancedIpc) {
          // Full structured-clone via the host<->wasm-runtime port.
          sendIpcStructuredMessage(childId, msg);
        } else {
          const json = JSON.stringify(msg);
          emitAsyncEvent(childId, EK.IPC_MESSAGE, new TextEncoder().encode(json));
        }
      },
      ipcDisconnect() {
        if (wantsAdvancedIpc) {
          sendIpcStructuredDisconnect(childId);
          ipcStructuredHandlers.delete(childId);
        } else {
          emitAsyncEvent(childId, EK.IPC_DISCONNECT, new Uint8Array(0));
        }
      },
    },
    ipcEnabled: req.ipc === true,
    signal: ac.signal,
    env: req.env,
    cwd: req.cwd,
    input: req.input,
    timeout: req.timeout,
    killSignal: req.killSignal,
    initialStdin: req.input,
    initialStdinEnded: req.input != null && req.input.byteLength > 0,
  });
  asyncSpawnChildren.set(childId, {
    childId,
    abortController: ac,
    done: false,
    source: ctx.source,
    ipcEnabled: req.ipc === true,
    ipcAdvanced: wantsAdvancedIpc,
  });
  // Advanced IPC: route wasm->executor messages from the host structured
  // port into the executor via the same source the RPC handlers use.
  if (wantsAdvancedIpc) {
    ipcStructuredHandlers.set(childId, (msg) => {
      const child = asyncSpawnChildren.get(childId);
      if (child) child.source.pushIpcMessage(msg);
    });
  }

  // Fire 'spawned' event on next microtask so the wasm side has time
  // to register listeners after the START reply arrives.
  queueMicrotask(() => {
    const pidBytes = new Uint8Array(4);
    new DataView(pidBytes.buffer).setUint32(0, childId, true);
    emitAsyncEvent(childId, EK.SPAWNED, pidBytes);
  });

  // Run executor; on resolve, fan out chunks + exit; on reject, exit with error.
  void (async () => {
    let result: ChildProcExecResult;
    try {
      result = await Promise.resolve(executor(req.command, req.args || [], ctx.opts));
    } catch (e) {
      // Distinguish abort-driven exits from genuine spawn errors:
      // - If ac.signal.aborted, this is a kill() reaction (cooperative
      //   executor honoring opts.signal). Emit ONLY exit with the kill
      //   signal -- wasm's ChildProcess fires 'exit' (null, killSignal)
      //   matching Node's "process terminated by signal" semantics.
      // - Otherwise the executor genuinely failed -- emit error + exit
      //   so wasm fires both 'error' and 'close'.
      if (ac.signal.aborted) {
        emitAsyncEvent(childId, EK.EXIT, packExitPayload(null, req.killSignal || "SIGTERM"));
      } else {
        const err = e instanceof Error ? e : new Error(String(e));
        const payload = new TextEncoder().encode(err.message);
        emitAsyncEvent(childId, EK.ERROR, payload);
        emitAsyncEvent(childId, EK.EXIT, packExitPayload(null, null));
      }
      const child = asyncSpawnChildren.get(childId);
      if (child) { child.done = true; asyncSpawnChildren.delete(childId); }
      ipcStructuredHandlers.delete(childId);
      return;
    }
    const toBytes = (v: Uint8Array | string | number[] | undefined): Uint8Array => {
      if (v == null) return new Uint8Array(0);
      if (v instanceof Uint8Array) return v;
      if (typeof v === "string") return new TextEncoder().encode(v);
      if (Array.isArray(v)) return new Uint8Array(v);
      return new TextEncoder().encode(String(v));
    };
    // Only emit final-buffer stdout/stderr for streams the executor
    // didn't push incrementally (avoid duplicating bytes).
    if (!ctx.usedStdoutStream()) emitChunked(childId, EK.STDOUT, toBytes(result.stdout));
    if (!ctx.usedStderrStream()) emitChunked(childId, EK.STDERR, toBytes(result.stderr));
    if (result.error) {
      const errJson = JSON.stringify({
        code: result.error.code || "ESPAWN",
        message: result.error.message || ("spawn " + req.command + " " + (result.error.code || "ESPAWN")),
      });
      emitAsyncEvent(childId, EK.ERROR, new TextEncoder().encode(errJson));
    }
    const sigName = ac.signal.aborted
      ? (req.killSignal || "SIGTERM")
      : (result.signal != null ? String(result.signal) : null);
    const code = typeof result.code === "number" ? result.code : (sigName ? null : 0);
    emitAsyncEvent(childId, EK.EXIT, packExitPayload(code, sigName));
    const child = asyncSpawnChildren.get(childId);
    if (child) { child.done = true; asyncSpawnChildren.delete(childId); }
  })();

  // Immediate START reply: childId + status=ok.
  const reply = new Uint8Array(8);
  const dv = new DataView(reply.buffer);
  dv.setUint32(0, childId, true);
  dv.setInt32(4, 0, true);
  return reply;
}

function killAsyncSpawn(requestBytes: Uint8Array): Uint8Array {
  if (requestBytes.byteLength < 8) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, 1, true); // invalid args
    return buf;
  }
  const dv = new DataView(requestBytes.buffer, requestBytes.byteOffset, requestBytes.byteLength);
  const childId = dv.getUint32(0, true);
  const reply = new Uint8Array(4);
  // P4.3 hard-kill path: terminate() halts the runner regardless of
  // cooperation. Synthesize exit so wasm-side ChildProcess fires
  // 'exit'/'close'.
  const runner = hardKillRunners.get(childId);
  if (runner) {
    ipcStructuredHandlers.delete(childId);
    runner.worker.terminate();
    hardKillRunners.delete(childId);
    emitAsyncEvent(childId, EK.EXIT, packExitPayload(null, "SIGTERM"));
    new DataView(reply.buffer).setUint32(0, 0, true);
    return reply;
  }
  const child = asyncSpawnChildren.get(childId);
  if (!child) {
    new DataView(reply.buffer).setUint32(0, 1, true); // no such child
    return reply;
  }
  // Cooperative path: signal abort, executor can cooperate via opts.signal.
  try { child.abortController.abort(); } catch (e) { void e; }
  new DataView(reply.buffer).setUint32(0, 0, true);
  return reply;
}

async function runChildProcessInHostWorker(requestBytes: Uint8Array): Promise<Uint8Array> {
  const req = unpackChildProcRequest(requestBytes);
  if (!req) {
    return packChildProcReply({
      stdout: new Uint8Array(0),
      stderr: new TextEncoder().encode("malformed run-child-process request"),
      code: null,
      signal: null,
      error: { code: "EINVAL", message: "malformed request" },
    });
  }
  const executor = (self as unknown as { __edgeChildProcessExecutor?: ChildProcExecutor })
    .__edgeChildProcessExecutor;
  if (typeof executor !== "function") {
    return packChildProcReply({ __noExecutor: true });
  }
  // P2 #16 audit fix: wire AbortController so timeout triggers opts.signal,
  // giving cooperating executors a chance to clean up. Non-cooperating
  // executors still leak (they ignore the signal and run to completion),
  // but cooperating ones now have the contract Node-async-spawn already
  // provides. Without this, the sync-path timeout was synthetic-only:
  // we returned ETIMEDOUT to the wasm side while the executor kept
  // burning host CPU.
  const ac = new AbortController();
  const opts: Record<string, unknown> = { signal: ac.signal };
  if (req.env) opts.env = req.env;
  if (req.cwd != null) opts.cwd = req.cwd;
  if (req.input) opts.input = req.input;
  if (typeof req.timeout === "number") opts.timeout = req.timeout;
  if (req.killSignal) opts.killSignal = req.killSignal;

  const executorPromise = Promise.resolve(executor(req.command, req.args || [], opts));
  let result: ChildProcExecResult;
  if (typeof req.timeout === "number" && req.timeout > 0) {
    const timeoutSentinel: unique symbol = Symbol("timeout") as never;
    const timer = new Promise<typeof timeoutSentinel>((resolve) =>
      setTimeout(() => resolve(timeoutSentinel), req.timeout),
    );
    const raced = await Promise.race([executorPromise, timer]);
    if (raced === timeoutSentinel) {
      // Fire the abort signal so cooperating executors can stop their
      // work (file handles, fetches, etc.). The promise they returned
      // may still resolve later, but we ignore it -- the wasm side has
      // already received our synthetic ETIMEDOUT result.
      try { ac.abort(); } catch (_e) { void _e; }
      result = {
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
        code: null,
        signal: req.killSignal || "SIGTERM",
        error: { code: "ETIMEDOUT", message: "spawnSync timed out after " + req.timeout + "ms" },
      };
    } else {
      result = raced as ChildProcExecResult;
    }
  } else {
    result = await executorPromise;
  }
  // Executor contract: returning null/undefined means "I don't handle
  // this command -- fall back to the wasm-side default fake shell."
  // Signal that to wasm via __noExecutor (same protocol as
  // "no executor installed at all"). Pre-P1.4 fix this fell through
  // by THROWING (packChildProcReply on null hit `"__noExecutor" in null`),
  // which the wasm-side caught and silently downgraded to fake-shell --
  // hiding real RPC errors at the same time.
  if (result == null) return packChildProcReply({ __noExecutor: true });
  return packChildProcReply(result);
}

// Called when main delivers an exit event from a spawned child.  We fire
// the reverse-RPC into our wasm runtime, which has a handler registered
// for OP_DELIVER_USER_WORKER_EXIT that invokes the user-supplied
// `worker.on('exit', cb)` callback.
function deliverUserWorkerExit(workerId: number, exitCode: number, errorBytes: Uint8Array | null): void {
  if (!reverseClient) {
    log(`deliver-user-worker-exit: reverseClient not attached (workerId=${workerId})`, "warn");
    return;
  }
  // Phase 3c (e33+): payload format is now [u32 workerId][u32 exitCode]
  // [u32 errBytesLen][bytes errBytes].  errBytesLen=0 means no error.
  // Parent wasm's reverse-RPC handler reads len at offset 8 and parses
  // accordingly.  Backward-compatible by virtue of always writing the
  // 12-byte minimum header (8 + 4-byte zero-length).
  const errLen = errorBytes ? errorBytes.byteLength : 0;
  const payload = new Uint8Array(12 + errLen);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, workerId, true);
  dv.setUint32(4, exitCode, true);
  dv.setUint32(8, errLen, true);
  if (errorBytes && errLen > 0) {
    payload.set(errorBytes, 12);
  }
  // Fire-and-forget — wasm's handler queues the callback for invocation
  // on its event loop; we don't need the reply value here.
  void reverseClient.call(OP_DELIVER_USER_WORKER_EXIT, hostWorkerId, 0, payload)
    .catch((err) => {
      log(`deliver-user-worker-exit: reverseClient.call threw: ${(err as Error).message}`, "warn");
    });
}

// Phase 2 postMessage: deliver a message FROM a child user-worker into
// this host's wasm runtime (which is the PARENT in this direction —
// main has already routed cross-host based on the userWorkers registry).
function deliverMessageFromChild(workerId: number, bytes: Uint8Array): void {
  if (!reverseClient) {
    log(`deliver-message-from-child: reverseClient not attached (workerId=${workerId})`, "warn");
    return;
  }
  const payload = new Uint8Array(8 + bytes.byteLength);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, workerId, true);
  dv.setUint32(4, bytes.byteLength, true);
  payload.set(bytes, 8);
  void reverseClient.call(OP_DELIVER_MESSAGE_FROM_CHILD, hostWorkerId, 0, payload)
    .catch((err) => {
      log(`deliver-message-from-child: reverseClient.call threw: ${(err as Error).message}`, "warn");
    });
}

// Phase 2 postMessage: deliver a message TO the wasm runtime running
// on this host (which is the CHILD user-worker in this direction).
function deliverMessageToChild(bytes: Uint8Array): void {
  if (!reverseClient) {
    log(`deliver-message-to-child: reverseClient not attached`, "warn");
    return;
  }
  const payload = new Uint8Array(4 + bytes.byteLength);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, bytes.byteLength, true);
  payload.set(bytes, 4);
  void reverseClient.call(OP_DELIVER_MESSAGE_TO_CHILD, hostWorkerId, 0, payload)
    .catch((err) => {
      log(`deliver-message-to-child: reverseClient.call threw: ${(err as Error).message}`, "warn");
    });
}

function registerHandlers(srv: RpcServer): void {
  // ping: round-trip with no payload.  Proof of life.
  srv.register(OP_PING, async () => ({
    payload: new Uint8Array(0),
    status: REPLY_STATUS_OK,
  }));

  // echo: round-trip a payload.  Used by L3 throughput bench.
  srv.register(OP_HOST_ECHO, async (_ctx, args) => {
    // Copy the args (they alias SAB; caller may free before reply lands).
    const copy = new Uint8Array(args.byteLength);
    copy.set(args);
    return { payload: copy, status: REPLY_STATUS_OK };
  });

  // L5 spike: run user JS on host worker's native V8.  Microtasks
  // queued by the script drain naturally because host's event loop
  // turns after the eval finishes — no JSPI suspend, no scope-depth
  // issue, no edge.js libuv wedging.
  //
  // Limitation today: only pure JS code.  Calls into Node API
  // (console.log, process.exit, fs, etc.) go through edge.js's
  // bindings which live on the wasm worker — they're NOT available
  // here.  We provide a minimal `console.log` stub that captures
  // stdout into an array; the reply payload is the concatenated
  // captured stdout.
  srv.register(OP_RUN_USER_SCRIPT, async (_ctx, args) => {
    const source = new TextDecoder("utf-8").decode(args);
    const out: string[] = [];
    const stringify = (parts: unknown[]) =>
      parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    const capturedConsole = {
      log: (...parts: unknown[]) => out.push(stringify(parts)),
      error: (...parts: unknown[]) => out.push(stringify(parts)),
      warn: (...parts: unknown[]) => out.push(stringify(parts)),
      info: (...parts: unknown[]) => out.push(stringify(parts)),
    };
    // F-6 settle semantics:
    //   - process.exit(code): the unambiguous "done" signal.  Mark
    //     exited, capture code, resolve exitPromise.  We do NOT throw —
    //     throwing inside a setTimeout callback escapes the user
    //     promise chain and surfaces as a worker error.  Further
    //     console output after exit is silently dropped.
    //   - process.nextTick: a separate FIFO queue that drains BEFORE
    //     Promise microtasks each time control returns to us, matching
    //     Node ordering.  Implemented by a checkpoint we install after
    //     the IIFE settles (and after each grace cycle): we splice the
    //     pending nextTick callbacks ahead of any queued .then().
    //   - settle/grace: after userPromise settles + microtask drain, we
    //     give pending macrotasks a 250ms grace window to fire (cut
    //     short by exitPromise).  Long enough for `setTimeout(...,50)`
    //     tests; short enough not to bloat run time.
    //   - safety timeout at 5s.
    let exitCode: number | null = null;
    let exited = false;
    let resolveExit: (() => void) | null = null;
    const exitPromise = new Promise<void>((r) => { resolveExit = r; });
    const nextTickQueue: Array<() => void> = [];
    const drainNextTicks = () => {
      while (nextTickQueue.length > 0) {
        const cb = nextTickQueue.shift();
        try { cb?.(); } catch (err) {
          if (!exited) out.push(`[nextTick error] ${(err as Error).message}`);
        }
      }
    };
    const stubProcess = {
      exit: (code = 0) => {
        if (!exited) {
          exited = true;
          exitCode = code;
          resolveExit?.();
        }
      },
      nextTick: (cb: () => void) => { nextTickQueue.push(cb); },
    };
    const liveConsole = {
      log: (...parts: unknown[]) => { if (!exited) out.push(stringify(parts)); },
      error: (...parts: unknown[]) => { if (!exited) out.push(stringify(parts)); },
      warn: (...parts: unknown[]) => { if (!exited) out.push(stringify(parts)); },
      info: (...parts: unknown[]) => { if (!exited) out.push(stringify(parts)); },
    };
    void capturedConsole; // kept for future use; F-6 path uses liveConsole
    try {
      // Run source body synchronously (no async IIFE wrapper) so we
      // can drain process.nextTick BEFORE V8's first microtask
      // checkpoint — that's what gets nextTick-before-Promise ordering
      // right.  Trade-off: source can't use top-level `await`.  For
      // user scripts that need that, edge.js still wraps via the wasm
      // path; this host path is for the microtask-ordering regression
      // class where top-level await is not used.
      const fn = new Function("console", "process", source);
      fn(liveConsole, stubProcess);
      // BEFORE yielding to the microtask queue: drain nextTicks.  This
      // is the part that beats Promise.then to the punch.
      drainNextTicks();
      // Now yield: Promise.then microtasks run.  Two awaits cover
      // recursive .then() chains (each .then enqueues another).
      for (let i = 0; i < 4; i++) await Promise.resolve();
      // Safety timeout race in case the source schedules something
      // that blocks indefinitely.  We've already done the sync body
      // and microtask drain; from here on we're only waiting for
      // timers + exit.
      void exitPromise; // (already wired)
      // Grace window: pending timers (e.g. setTimeout 50ms) get a chance
      // to fire and signal exit.  Cut short by exitPromise.
      if (!exited) {
        const graceMs = 250;
        const tGrace = Date.now() + graceMs;
        while (Date.now() < tGrace && !exited) {
          await Promise.race([
            exitPromise,
            new Promise<void>((r) => setTimeout(r, 25)),
          ]);
          drainNextTicks();
        }
      }
      await Promise.resolve(); // final microtask checkpoint
      const payload = new TextEncoder().encode(
        out.join("\n") + (exitCode !== null ? `\n__EXIT_CODE__:${exitCode}` : ""),
      );
      return { payload, status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.stack ?? e.message : String(e)) || "user script threw";
      const payload = new TextEncoder().encode(out.join("\n") + "\n\nERROR: " + msg);
      return { payload, status: REPLY_STATUS_HOST_ERROR };
    }
  });

  // E18: SubtleCrypto.digest bridge.  Lets the wasm-side
  // `crypto-hash-via-host-worker` policy turn `Hash.prototype.digest`
  // into a synchronous call by parking the wasm thread on a sync RPC
  // while the host worker awaits the async `subtle.digest(...)` and
  // writes the bytes back to the reply slot.
  //
  // Request payload (LE u32 lengths, contiguous bytes):
  //   [u32 algo_name_len][utf-8 algo_name][u32 data_len][data]
  // Reply payload: raw digest bytes (e.g. 32 for SHA-256).
  srv.register(OP_SUBTLE_DIGEST, async (_ctx, args) => {
    try {
      if (args.byteLength < 8) {
        return {
          payload: new TextEncoder().encode("subtle-digest: args too short"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const algoLen = dv.getUint32(0, true);
      if (4 + algoLen + 4 > args.byteLength) {
        return {
          payload: new TextEncoder().encode("subtle-digest: algo_name overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const algoName = new TextDecoder("utf-8").decode(
        args.subarray(4, 4 + algoLen),
      );
      const dataLen = dv.getUint32(4 + algoLen, true);
      const dataOff = 4 + algoLen + 4;
      if (dataOff + dataLen > args.byteLength) {
        return {
          payload: new TextEncoder().encode("subtle-digest: data overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      // Copy bytes into a JS-heap buffer.  SubtleCrypto rejects SAB-backed
      // views on most runtimes; copy keeps it portable.
      const dataCopy = new Uint8Array(dataLen);
      if (dataLen > 0) {
        dataCopy.set(args.subarray(dataOff, dataOff + dataLen));
      }
      const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
      if (!subtle) {
        return {
          payload: new TextEncoder().encode("subtle-digest: host SubtleCrypto unavailable"),
          status: REPLY_STATUS_HOST_ERROR,
        };
      }
      const ab = await subtle.digest(algoName, dataCopy);
      const out = new Uint8Array(ab.byteLength);
      out.set(new Uint8Array(ab));
      return { payload: out, status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) || "subtle-digest threw";
      return {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_HOST_ERROR,
      };
    }
  });

  // E21: SubtleCrypto HMAC bridge.  Lets the wasm-side
  // `crypto-hmac-via-host-worker` policy turn `Hmac.prototype.digest`
  // into a synchronous call.  Pattern mirrors OP_SUBTLE_DIGEST above;
  // wire format extends with a key-bytes preamble.
  //
  // Request payload (LE u32 lengths, contiguous bytes):
  //   [u32 algo_name_len][utf-8 algo_name][u32 key_len][key_bytes][u32 data_len][data]
  // Reply payload: raw HMAC bytes (e.g. 32 for HMAC-SHA-256).
  srv.register(OP_SUBTLE_HMAC, async (_ctx, args) => {
    try {
      if (args.byteLength < 12) {
        return {
          payload: new TextEncoder().encode("subtle-hmac: args too short"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const algoLen = dv.getUint32(0, true);
      if (4 + algoLen + 4 > args.byteLength) {
        return {
          payload: new TextEncoder().encode("subtle-hmac: algo_name overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const algoName = new TextDecoder("utf-8").decode(
        args.subarray(4, 4 + algoLen),
      );
      const keyLenOff = 4 + algoLen;
      const keyLen = dv.getUint32(keyLenOff, true);
      const keyOff = keyLenOff + 4;
      if (keyOff + keyLen + 4 > args.byteLength) {
        return {
          payload: new TextEncoder().encode("subtle-hmac: key overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const dataLenOff = keyOff + keyLen;
      const dataLen = dv.getUint32(dataLenOff, true);
      const dataOff = dataLenOff + 4;
      if (dataOff + dataLen > args.byteLength) {
        return {
          payload: new TextEncoder().encode("subtle-hmac: data overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const keyCopy = new Uint8Array(keyLen);
      if (keyLen > 0) keyCopy.set(args.subarray(keyOff, keyOff + keyLen));
      const dataCopy = new Uint8Array(dataLen);
      if (dataLen > 0) dataCopy.set(args.subarray(dataOff, dataOff + dataLen));
      const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
      if (!subtle) {
        return {
          payload: new TextEncoder().encode("subtle-hmac: host SubtleCrypto unavailable"),
          status: REPLY_STATUS_HOST_ERROR,
        };
      }
      const cryptoKey = await subtle.importKey(
        "raw",
        keyCopy,
        { name: "HMAC", hash: algoName },
        false,
        ["sign"],
      );
      const ab = await subtle.sign("HMAC", cryptoKey, dataCopy);
      const out = new Uint8Array(ab.byteLength);
      out.set(new Uint8Array(ab));
      return { payload: out, status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) || "subtle-hmac threw";
      return {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_HOST_ERROR,
      };
    }
  });

  // E22: digest with data delivered via shared napi-host-memory.  Same
  // semantics as OP_SUBTLE_DIGEST, but the RPC request only carries
  //   [u32 algo_name_len][utf-8 algo_name][u32 data_offset][u32 data_len]
  // — the bytes themselves live in `napiHostMemory.buffer` at
  // `data_offset` (typically DIGEST_STAGING_OFFSET).  Unblocks inputs
  // larger than a single 4 KiB RPC slot (the E18 cap, see NOTES.md
  // `e18-slot-overflow`).
  //
  // Memory model: the wasm runtime worker attached a SAB view of
  // `napiHostMemory.buffer` via the F-2 plumbing (worker.ts /
  // `getHostNapiMemoryView`), so a write on the wasm side is visible
  // here without any postMessage.  The wasm worker is single-flight on
  // this sync RPC (Atomics.wait blocks its thread), so reusing the same
  // staging offset across calls is safe — no concurrent overlap.
  srv.register(OP_SUBTLE_DIGEST_VIA_NAPI_MEM, async (_ctx, args) => {
    try {
      if (args.byteLength < 12) {
        return {
          payload: new TextEncoder().encode("subtle-digest-via-napi: args too short"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const algoLen = dv.getUint32(0, true);
      if (4 + algoLen + 8 > args.byteLength) {
        return {
          payload: new TextEncoder().encode("subtle-digest-via-napi: algo_name overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const algoName = new TextDecoder("utf-8").decode(
        args.subarray(4, 4 + algoLen),
      );
      const dataOffset = dv.getUint32(4 + algoLen, true);
      const dataLen = dv.getUint32(4 + algoLen + 4, true);
      // Make sure the napi memory exists and the region is in range.
      ensureNapiContext();
      const mem = napiHostMemory!;
      if (dataOffset + dataLen > mem.buffer.byteLength) {
        return {
          payload: new TextEncoder().encode(
            `subtle-digest-via-napi: (offset=${dataOffset}+len=${dataLen}) ` +
            `exceeds napi memory ${mem.buffer.byteLength}`,
          ),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      // Copy bytes from the shared SAB into a JS-heap buffer.
      // SubtleCrypto.digest rejects SAB-backed views in most runtimes
      // (Chrome's spec compliance for the 2024 SAB-friendly update is
      // still partial); the copy is portable.  The copy is also what
      // E18 does — the win here is bypassing the 4 KiB slot framing,
      // not eliminating that single copy.
      const dataCopy = new Uint8Array(dataLen);
      if (dataLen > 0) {
        dataCopy.set(new Uint8Array(mem.buffer, dataOffset, dataLen));
      }
      const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
      if (!subtle) {
        return {
          payload: new TextEncoder().encode("subtle-digest-via-napi: host SubtleCrypto unavailable"),
          status: REPLY_STATUS_HOST_ERROR,
        };
      }
      const ab = await subtle.digest(algoName, dataCopy);
      const out = new Uint8Array(ab.byteLength);
      out.set(new Uint8Array(ab));
      return { payload: out, status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) || "subtle-digest-via-napi threw";
      return {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_HOST_ERROR,
      };
    }
  });

  // E22-C: HMAC with key+data delivered via shared napi-host-memory.
  // Same semantics as OP_SUBTLE_HMAC, but the RPC request only carries
  //   [u32 algo_name_len][algo_name]
  //   [u32 key_off][u32 key_len][u32 data_off][u32 data_len]
  // — the bytes themselves live in `napiHostMemory.buffer` at the
  // given offsets.  Unblocks combined inputs larger than the 4 KiB
  // single-slot framing cap E21 inherited from E18.  Shares the
  // digest staging region; safe because both ops are single-flight
  // (sync RPC blocks the wasm thread).
  srv.register(OP_SUBTLE_HMAC_VIA_NAPI_MEM, async (_ctx, args) => {
    try {
      if (args.byteLength < 20) {
        return {
          payload: new TextEncoder().encode("subtle-hmac-via-napi: args too short"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const algoLen = dv.getUint32(0, true);
      if (4 + algoLen + 16 > args.byteLength) {
        return {
          payload: new TextEncoder().encode("subtle-hmac-via-napi: algo_name overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const algoName = new TextDecoder("utf-8").decode(
        args.subarray(4, 4 + algoLen),
      );
      const keyOffset = dv.getUint32(4 + algoLen, true);
      const keyLen = dv.getUint32(4 + algoLen + 4, true);
      const dataOffset = dv.getUint32(4 + algoLen + 8, true);
      const dataLen = dv.getUint32(4 + algoLen + 12, true);
      ensureNapiContext();
      const mem = napiHostMemory!;
      if (keyOffset + keyLen > mem.buffer.byteLength) {
        return {
          payload: new TextEncoder().encode(
            `subtle-hmac-via-napi: key (off=${keyOffset}+len=${keyLen}) ` +
            `exceeds napi memory ${mem.buffer.byteLength}`,
          ),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      if (dataOffset + dataLen > mem.buffer.byteLength) {
        return {
          payload: new TextEncoder().encode(
            `subtle-hmac-via-napi: data (off=${dataOffset}+len=${dataLen}) ` +
            `exceeds napi memory ${mem.buffer.byteLength}`,
          ),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      // Copy bytes from the shared SAB into JS-heap buffers.  SubtleCrypto
      // (importKey + sign) rejects SAB-backed views in most runtimes;
      // copy keeps it portable.  Single-flight RPC means no overlap.
      const keyCopy = new Uint8Array(keyLen);
      if (keyLen > 0) keyCopy.set(new Uint8Array(mem.buffer, keyOffset, keyLen));
      const dataCopy = new Uint8Array(dataLen);
      if (dataLen > 0) dataCopy.set(new Uint8Array(mem.buffer, dataOffset, dataLen));
      const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
      if (!subtle) {
        return {
          payload: new TextEncoder().encode("subtle-hmac-via-napi: host SubtleCrypto unavailable"),
          status: REPLY_STATUS_HOST_ERROR,
        };
      }
      const cryptoKey = await subtle.importKey(
        "raw",
        keyCopy,
        { name: "HMAC", hash: algoName },
        false,
        ["sign"],
      );
      const ab = await subtle.sign("HMAC", cryptoKey, dataCopy);
      const out = new Uint8Array(ab.byteLength);
      out.set(new Uint8Array(ab));
      return { payload: out, status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) || "subtle-hmac-via-napi threw";
      return {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_HOST_ERROR,
      };
    }
  });

  // Worker_threads phase 1: spawn a user-worker pair on main.
  //
  // Request payload layout (LE u32):
  //   [u32 bootstrap_len][utf-8 bootstrap_script]
  //   [u32 worker_data_len][worker_data bytes]
  // Reply payload: [u32 workerId] (LE).
  //
  // Per Path B (docs/worker-threads-design.md): the calling JS context
  // is lib's `worker.js` patched-constructor running on the parent's
  // wasm runtime worker; it invoked `globalThis.__edgeSpawnNodeWorker`
  // which routed here via sync RPC.  This handler does NOT spawn the
  // pair itself (main has the WebAssembly.Module cache + the userWorkers
  // registry); it forwards to main and awaits the assigned workerId.
  //
  // `bootstrapScript` is a JS source string the child wasm runtime will
  // execute as its user-script slot after edge.js boots.  See worker.ts
  // for the calling-convention comment.
  srv.register(OP_SPAWN_USER_WORKER, async (_ctx, args) => {
    try {
      if (args.byteLength < 8) {
        return {
          payload: new TextEncoder().encode("spawn-user-worker: args too short"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const bsLen = dv.getUint32(0, true);
      if (4 + bsLen + 4 > args.byteLength) {
        return {
          payload: new TextEncoder().encode("spawn-user-worker: bootstrap_script overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const bootstrapScript = new TextDecoder("utf-8").decode(
        args.subarray(4, 4 + bsLen),
      );
      const workerDataLen = dv.getUint32(4 + bsLen, true);
      if (4 + bsLen + 4 + workerDataLen > args.byteLength) {
        return {
          payload: new TextEncoder().encode("spawn-user-worker: worker_data overruns payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const workerDataStart = 4 + bsLen + 4;
      const workerData = args.subarray(workerDataStart, workerDataStart + workerDataLen);
      // Copy because the args buffer aliases the SAB slot; main reuses
      // workerData across postMessage and structuredClone semantics
      // require a stable buffer.
      const workerDataCopy = new Uint8Array(workerData.byteLength);
      workerDataCopy.set(workerData);

      const workerId = await postToMainAndAwaitSpawn(bootstrapScript, workerDataCopy);

      const reply = new Uint8Array(4);
      new DataView(reply.buffer).setUint32(0, workerId, true);
      return { payload: reply, status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) || "spawn-user-worker threw";
      return {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_HOST_ERROR,
      };
    }
  });

  // child-process-via-executor async path. Wasm spawnSync -> here.
  // Executor runs in THIS host worker (installed by the deployment via
  // init bootScript) -- main thread is never involved per the
  // architectural rule. The host worker's event loop stays free while
  // the wasm worker is blocked on Atomics.wait.
  //
  // Binary wire format -- see child-process-via-executor.ts for the
  // request/reply layout. Replaced JSON-number-arrays encoding to
  // recover ~6x of slot budget for stdio bytes.
  srv.register(OP_RUN_CHILD_PROCESS, async (_ctx, args) => {
    try {
      // Copy out -- args aliases the SAB slot which gets reused.
      const argsCopy = new Uint8Array(args.byteLength);
      argsCopy.set(args);
      const replyBytes = await runChildProcessInHostWorker(argsCopy);
      return {
        payload: replyBytes,
        status: REPLY_STATUS_OK,
      };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) || "run-child-process threw";
      return {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_HOST_ERROR,
      };
    }
  });

  // Async spawn() / exec() / execFile() start. Reply is immediate
  // (childId + status); events stream back via OP_SPAWN_ASYNC_EVENT
  // reverse RPC.
  srv.register(OP_SPAWN_ASYNC_START, async (_ctx, args) => {
    const argsCopy = new Uint8Array(args.byteLength);
    argsCopy.set(args);
    const replyBytes = await startAsyncSpawn(argsCopy);
    return { payload: replyBytes, status: REPLY_STATUS_OK };
  });

  // Async kill. Aborts the executor via AbortSignal; events fire as
  // executor cooperates (or as it finishes naturally if it doesn't).
  srv.register(OP_SPAWN_ASYNC_KILL, async (_ctx, args) => {
    const argsCopy = new Uint8Array(args.byteLength);
    argsCopy.set(args);
    const replyBytes = killAsyncSpawn(argsCopy);
    return { payload: replyBytes, status: REPLY_STATUS_OK };
  });

  // P3.2 + P3.5: streaming stdio. Wasm-side child.stdin.write() (fd 0)
  // or child.stdio[N].write() (fd N>=3) lands here as sync RPC; we route
  // the bytes through the executor-context source (cooperative path) or
  // forward to the runner worker (hard-kill path). fd 1/2 are output
  // directions (executor writes, wasm reads) -- writing TO them is a
  // protocol error (status 1). Status: 0=ok, 1=no-such-child / invalid fd.
  srv.register(OP_SPAWN_STDIO_WRITE, async (_ctx, args) => {
    const reply = new Uint8Array(4);
    const dv = new DataView(reply.buffer);
    if (args.byteLength < 8) {
      dv.setUint32(0, 1, true);
      return { payload: reply, status: REPLY_STATUS_OK };
    }
    const inDv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const childId = inDv.getUint32(0, true);
    const fdIndex = inDv.getUint32(4, true);
    if (fdIndex === 1 || fdIndex === 2) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    // Copy data out of the SAB slot view since the slot may be reused
    // before the executor consumes the chunk.
    const chunk = new Uint8Array(args.byteLength - 8);
    chunk.set(args.subarray(8));
    const hk = hardKillRunners.get(childId);
    if (hk) {
      if (fdIndex === 0) hk.worker.postMessage({ kind: "stdin-chunk", bytes: chunk });
      else hk.worker.postMessage({ kind: "stdio-chunk", fd: fdIndex, bytes: chunk });
      dv.setUint32(0, 0, true);
      return { payload: reply, status: REPLY_STATUS_OK };
    }
    const child = asyncSpawnChildren.get(childId);
    if (!child) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    if (fdIndex === 0) child.source.pushStdin(chunk);
    else child.source.pushStdio(fdIndex, chunk);
    dv.setUint32(0, 0, true);
    return { payload: reply, status: REPLY_STATUS_OK };
  });

  // P3.2 + P3.5: signal end-of-stream for an stdio pipe. Idempotent.
  srv.register(OP_SPAWN_STDIO_END, async (_ctx, args) => {
    const reply = new Uint8Array(4);
    const dv = new DataView(reply.buffer);
    if (args.byteLength < 8) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    const inDv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const childId = inDv.getUint32(0, true);
    const fdIndex = inDv.getUint32(4, true);
    if (fdIndex === 1 || fdIndex === 2) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    const hk = hardKillRunners.get(childId);
    if (hk) {
      if (fdIndex === 0) hk.worker.postMessage({ kind: "stdin-end" });
      else hk.worker.postMessage({ kind: "stdio-end", fd: fdIndex });
      dv.setUint32(0, 0, true);
      return { payload: reply, status: REPLY_STATUS_OK };
    }
    const child = asyncSpawnChildren.get(childId);
    if (!child) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    if (fdIndex === 0) child.source.endStdin();
    else child.source.endStdio(fdIndex);
    dv.setUint32(0, 0, true);
    return { payload: reply, status: REPLY_STATUS_OK };
  });

  // P3.3: parent -> child IPC message. Wasm-side child.send(obj)
  // serializes to JSON, lands here as sync RPC. We route through the
  // executor-context source (cooperative path) or forward to the runner
  // (hard-kill path). status: 0=ok, 1=no-such-child, 2=disconnected,
  // 3=invalid-json.
  srv.register(OP_SPAWN_IPC_SEND, async (_ctx, args) => {
    const reply = new Uint8Array(4);
    const dv = new DataView(reply.buffer);
    if (args.byteLength < 8) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    const inDv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const childId = inDv.getUint32(0, true);
    const jsonLen = inDv.getUint32(4, true);
    if (8 + jsonLen > args.byteLength) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    const hk = hardKillRunners.get(childId);
    if (hk) {
      if (!hk.ipcEnabled) { dv.setUint32(0, 2, true); return { payload: reply, status: REPLY_STATUS_OK }; }
      let msg: unknown;
      try { msg = JSON.parse(new TextDecoder().decode(args.subarray(8, 8 + jsonLen))); }
      catch { dv.setUint32(0, 3, true); return { payload: reply, status: REPLY_STATUS_OK }; }
      hk.worker.postMessage({ kind: "ipc-msg", msg });
      dv.setUint32(0, 0, true);
      return { payload: reply, status: REPLY_STATUS_OK };
    }
    const child = asyncSpawnChildren.get(childId);
    if (!child) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    if (!child.ipcEnabled) { dv.setUint32(0, 2, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    let msg: unknown;
    try { msg = JSON.parse(new TextDecoder().decode(args.subarray(8, 8 + jsonLen))); }
    catch { dv.setUint32(0, 3, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    // Dispatch in microtask so handlers don't run synchronously inside
    // the RPC reply path (avoid blocking the wasm RPC client longer
    // than necessary -- it's parked in Atomics.wait waiting for our reply).
    queueMicrotask(() => child.source.pushIpcMessage(msg));
    dv.setUint32(0, 0, true);
    return { payload: reply, status: REPLY_STATUS_OK };
  });

  // P3.3: parent-initiated disconnect. Marks IPC channel closed; fires
  // executor's onDisconnect handlers. Subsequent send() from either
  // side returns status=2. Symmetric path (executor opts.ipc.disconnect)
  // routes through the sink, which fires OP_SPAWN_ASYNC_EVENT IPC_DISCONNECT
  // toward wasm.
  srv.register(OP_SPAWN_IPC_DISCONNECT, async (_ctx, args) => {
    const reply = new Uint8Array(4);
    const dv = new DataView(reply.buffer);
    if (args.byteLength < 4) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    const inDv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const childId = inDv.getUint32(0, true);
    const hk = hardKillRunners.get(childId);
    if (hk) {
      if (hk.ipcEnabled) {
        hk.ipcEnabled = false;
        hk.worker.postMessage({ kind: "ipc-disconnect" });
      }
      dv.setUint32(0, 0, true);
      return { payload: reply, status: REPLY_STATUS_OK };
    }
    const child = asyncSpawnChildren.get(childId);
    if (!child) { dv.setUint32(0, 1, true); return { payload: reply, status: REPLY_STATUS_OK }; }
    if (child.ipcEnabled) {
      child.ipcEnabled = false;
      ipcStructuredHandlers.delete(childId);
      child.source.pushIpcDisconnect();
    }
    dv.setUint32(0, 0, true);
    return { payload: reply, status: REPLY_STATUS_OK };
  });

  // Worker_threads phase 2: parent's wasm calls this when user JS does
  // `worker.postMessage(data)`.  We unframe (workerId, bytes) and post
  // to main, which routes to the child host's `deliver-message-to-child`
  // listener.  Fire-and-forget — sync RPC ack means "enqueued for
  // delivery," not "delivered" (matching Node's postMessage semantics).
  //
  // Request payload layout (LE u32):
  //   [u32 workerId][u32 bytes_len][marshaled bytes]
  srv.register(OP_WORKER_POST_MESSAGE_TO_CHILD, async (_ctx, args) => {
    try {
      if (args.byteLength < 8) {
        return {
          payload: new TextEncoder().encode("post-message-to-child: args too short"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const workerId = dv.getUint32(0, true);
      const bytesLen = dv.getUint32(4, true);
      if (8 + bytesLen > args.byteLength) {
        return {
          payload: new TextEncoder().encode("post-message-to-child: bytes overrun payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      // Copy the marshaled-bytes view — args aliases the SAB slot which
      // may be reused before main reads it via postMessage.  structured-
      // cloneable transferrable; we don't transfer because the caller
      // (wasm) may still hold a reference.
      const bytes = new Uint8Array(bytesLen);
      bytes.set(new Uint8Array(args.buffer, args.byteOffset + 8, bytesLen));
      self.postMessage({
        kind: "worker-message-to-child",
        parentHostWorkerId: hostWorkerId,
        workerId,
        bytes,
      });
      return { payload: new Uint8Array(0), status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) || "post-message-to-child threw";
      return {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_HOST_ERROR,
      };
    }
  });

  // Worker_threads phase 2: child's wasm calls this when user JS does
  // `parentPort.postMessage(data)`.  No workerId in the payload — main
  // looks up the parent's host via the userWorkers registry keyed on
  // THIS host's id.
  //
  // Request payload layout (LE u32):
  //   [u32 bytes_len][marshaled bytes]
  srv.register(OP_WORKER_POST_MESSAGE_TO_PARENT, async (_ctx, args) => {
    try {
      if (args.byteLength < 4) {
        return {
          payload: new TextEncoder().encode("post-message-to-parent: args too short"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const bytesLen = dv.getUint32(0, true);
      if (4 + bytesLen > args.byteLength) {
        return {
          payload: new TextEncoder().encode("post-message-to-parent: bytes overrun payload"),
          status: REPLY_STATUS_INVALID_ARGS,
        };
      }
      const bytes = new Uint8Array(bytesLen);
      bytes.set(new Uint8Array(args.buffer, args.byteOffset + 4, bytesLen));
      self.postMessage({
        kind: "worker-message-to-parent",
        childHostWorkerId: hostWorkerId,
        bytes,
      });
      return { payload: new Uint8Array(0), status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)) || "post-message-to-parent threw";
      return {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_HOST_ERROR,
      };
    }
  });

  // F-1: NAPI handlers.  Each one delegates to host's emnapi context.
  //
  // Request payload layout: 8 bytes = (envHandle u32, resultPtr u32).
  // Reply payload: empty (the handle id is written to memory at
  // resultPtr by the napi function itself).  Status code is the
  // napi_status — 0 on success.
  //
  // F-1 limitation: memory is host-local (not yet shared with wasm).
  // The probe in main.ts uses a JS-only test that doesn't need real
  // wasm to verify the plumbing works.  F-2 swaps in shared memory.
  function makeNapiTwoArgHandler(napiOpName: string) {
    return async (_ctx: unknown, args: Uint8Array) => {
      if (args.byteLength < 8) {
        const msg = new TextEncoder().encode("napi handler: args too short");
        return { payload: msg, status: REPLY_STATUS_INVALID_ARGS };
      }
      ensureNapiContext();
      const view = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const envHandle = view.getUint32(0, true);
      const resultPtr = view.getUint32(4, true);
      const fn = napiModuleHost!.imports.napi?.[napiOpName] as ((env: number, ptr: number) => number) | undefined;
      if (typeof fn !== "function") {
        const msg = new TextEncoder().encode(`napi handler: ${napiOpName} not found`);
        return { payload: msg, status: REPLY_STATUS_INVALID_ARGS };
      }
      const napiStatus = fn(envHandle, resultPtr);
      // Reply carries the napi_status as the RPC status field.
      return { payload: new Uint8Array(0), status: napiStatus };
    };
  }

  srv.register(OP_NAPI_GET_UNDEFINED, makeNapiTwoArgHandler("napi_get_undefined"));
  srv.register(OP_NAPI_GET_NULL,      makeNapiTwoArgHandler("napi_get_null"));
  srv.register(OP_NAPI_GET_GLOBAL,    makeNapiTwoArgHandler("napi_get_global"));

  // F-4: bulk-register read-only napi ops (~28 more).
  ensureNapiContext();
  const napi = napiModuleHost!.imports.napi ?? {};
  const registry = makeNapiOpRegistry(napi as Record<string, (...args: number[]) => number>);
  registry.register(srv);
  log(`F-4 napi op handlers registered: ${registry.count} additional ops`);

  // ── B / scope-op forwarding (mirror wasm-side scope discipline) ──
  //
  // OPEN: wasm-side has already called napi_open_handle_scope and got
  // its own scope id; here we open a parallel scope on the host so
  // handles allocated by host-RPC ops during this scope's lifetime get
  // released when the wasm side closes.
  //
  // CLOSE: looks up the host scope by id and calls closeScope, which
  // calls handleStore.erase(start, end) — releasing every handle
  // allocated between open and close.
  //
  // We track host scopes by their emnapi scope id (`scope.id`) so the
  // wasm side can pass it back to identify which to close.  Out-of-
  // order closes are tolerated: emnapi's scope chain handles that via
  // Disposable.dispose() — we just pass the scope object back through.
  //
  // Env: the wasm-side env id and the host's env id are different
  // namespaces.  The host has exactly ONE env (id=1, minted by the
  // stub `emnapi_create_env` in ensureNapiContext).  So the wasm side
  // sends its own envId for diagnostics, but the host always resolves
  // its own env via envStore.  If/when host becomes multi-env, we'd
  // add an envId→hostEnvId map here.
  {
    type Scope = ReturnType<NonNullable<typeof napiCtx>["openScope"]>;
    const hostScopes = new Map<number, Scope>();
    // Resolve the host's single env (id=1 from stub).  v1.10 has it
    // in envStore._values[1]; the simpler accessor is envStore.get(1).
    const getHostEnv = (): unknown => {
      type CtxLike = { envStore?: { get?: (id: number) => unknown }; getEnv?: (id: number) => unknown };
      const c = napiCtx as unknown as CtxLike;
      if (c.getEnv) return c.getEnv(1);
      if (c.envStore?.get) return c.envStore.get(1);
      return undefined;
    };

    srv.register(OP_NAPI_OPEN_HANDLE_SCOPE, async (_ctx, _args) => {
      if (!napiCtx || !napiModuleHost) {
        return { payload: new TextEncoder().encode("scope: host emnapi not ready"), status: REPLY_STATUS_HOST_ERROR };
      }
      const env = getHostEnv();
      if (!env) {
        return { payload: new TextEncoder().encode("scope: host env not found"), status: REPLY_STATUS_HOST_ERROR };
      }
      const scope = napiCtx.openScope(env as never);
      const scopeId = Number(scope.id);
      hostScopes.set(scopeId, scope);
      const reply = new Uint8Array(4);
      new DataView(reply.buffer).setUint32(0, scopeId >>> 0, true);
      return { payload: reply, status: REPLY_STATUS_OK };
    });

    srv.register(OP_NAPI_CLOSE_HANDLE_SCOPE, async (_ctx, args) => {
      if (!napiCtx) {
        return { payload: new TextEncoder().encode("scope: host emnapi not ready"), status: REPLY_STATUS_HOST_ERROR };
      }
      if (args.byteLength < 4) {
        return { payload: new TextEncoder().encode("scope: close args too short"), status: REPLY_STATUS_INVALID_ARGS };
      }
      const scopeId = new DataView(args.buffer, args.byteOffset, args.byteLength).getUint32(0, true);
      const env = getHostEnv();
      const scope = hostScopes.get(scopeId);
      if (!env || !scope) {
        // Tolerate out-of-order/stale closes: emnapi swallows them
        // too — see scope's Disposable.dispose() which is idempotent.
        hostScopes.delete(scopeId);
        return { payload: new Uint8Array(0), status: REPLY_STATUS_OK };
      }
      try {
        napiCtx.closeScope(env as never, scope);
      } catch (e) {
        // closeScope can throw if the scope chain is in an odd state;
        // swallow so the wasm side never gets stuck on a bad scope id.
        log(`closeScope threw for scopeId=${scopeId}: ${(e as Error).message}`, "warn");
      }
      hostScopes.delete(scopeId);
      return { payload: new Uint8Array(0), status: REPLY_STATUS_OK };
    });

    srv.register(OP_NAPI_DEBUG_HANDLE_STORE_SIZE, async (_ctx, _args) => {
      if (!napiCtx) {
        return { payload: new TextEncoder().encode("debug: host emnapi not ready"), status: REPLY_STATUS_HOST_ERROR };
      }
      // Read the handle store's "next id about to be assigned" cursor
      // — the canonical "live handles" metric.  Scope close calls
      // handleStore.erase(start, end), which sets _next back to start,
      // so this value SHRINKS when scopes are discarded.  The internal
      // _values array length only grows (it caches Handle wrappers for
      // reuse), so we don't measure that.
      //
      // emnapi v1 (npm @emnapi/runtime 1.10): the property is `_next`.
      // emnapi v2 (vendored): the property is `_allocator.next`.
      // Fall back across both shapes to keep this op stable when the
      // vendored swap flag flips.
      type V1Shape = { _next?: number };
      type V2Shape = { _allocator?: { next: number } };
      type HandleStoreShape = V1Shape & V2Shape & { _values?: unknown[] };
      const hs = (napiCtx as unknown as { handleStore?: HandleStoreShape }).handleStore;
      const next = hs?._next ?? hs?._allocator?.next ?? hs?._values?.length ?? 0;
      const reply = new Uint8Array(4);
      new DataView(reply.buffer).setUint32(0, next >>> 0, true);
      return { payload: reply, status: REPLY_STATUS_OK };
    });
    log(`scope-forwarding ops registered: open, close, debug_size`);
  }

  // OP_HOST_READY is host→wasm; host doesn't receive it.  No handler.
  void OP_HOST_READY;
}

/** F-1 probe support: expose the napi memory so the page-side probe
 *  can verify what the handlers wrote.  Sent in the ready message. */
function getNapiMemorySab(): SharedArrayBuffer | null {
  // ensureNapiContext is called lazily on first napi op; force it now
  // so the SAB exists when the probe wants to read.
  ensureNapiContext();
  return napiHostMemory!.buffer as unknown as SharedArrayBuffer;
}

async function runReverseEcho(bytes: number): Promise<void> {
  if (!reverseClient) {
    log("reverse-echo: reverseClient not ready", "err");
    return;
  }
  const { OP_WASM_ECHO } = await import("./rpc-protocol");
  const payload = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) payload[i] = i & 0xff;
  const t0 = performance.now();
  const res = await reverseClient.call(OP_WASM_ECHO, hostWorkerId, 0, payload);
  const dt = performance.now() - t0;
  if (res.status !== 0 || res.payload.byteLength !== bytes) {
    log(`reverse-echo FAILED: status=${res.status} bytes=${res.payload.byteLength}`, "err");
    return;
  }
  // Verify bytes round-tripped.
  for (let i = 0; i < bytes; i++) {
    if (res.payload[i] !== (i & 0xff)) {
      log(`reverse-echo: byte mismatch at index ${i}`, "err");
      return;
    }
  }
  log(`reverse-echo: ok ${bytes}B in ${dt.toFixed(3)}ms`);
}

// R10 fix: module-level idempotency guard.  host-worker.ts loads
// TWICE in production (confirmed by MODULE LOAD instrumentation —
// likely Vite dev-mode quirk).  Without this guard, the second load
// attaches a SECOND message listener which creates a SECOND RpcServer
// + napi context on the SAME SAB rings.  Requests then race between
// two servers, each with its own napiHostMemory.  Writes from
// server-B's emnapi land in memory-B, but we send memory-A's SAB to
// the page → some ops appear to "succeed but write nothing".
//
// Fix: only the FIRST module load attaches the listener / runs the
// init handler.  Subsequent loads are inert.  This works because
// only ONE handler running prevents the dual-RpcServer race.
//
// See experiments/r10-emnapi-silent-write/FINDINGS.md.
{
  const g = globalThis as { __edgeHostListenerAttached?: boolean };
  if (g.__edgeHostListenerAttached) {
    self.postMessage({
      kind: "host-log",
      text: `[host-worker:?] MODULE LOAD #${(globalThis as { __edgeHostModuleLoadCount?: number }).__edgeHostModuleLoadCount} — skipping listener (already attached)`,
      level: "warn",
    });
  } else {
    g.__edgeHostListenerAttached = true;
    self.postMessage({
      kind: "host-log",
      text: `[host-worker:?] MODULE LOAD: attaching listener`,
      level: "info",
    });
    attachMessageListener();
  }
}

function attachMessageListener(): void {
self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as (Partial<InitMessage> | ReverseEchoMessage | {
    kind: "spawn-user-worker-reply";
    requestId: number;
    workerId?: number;
    error?: string;
  } | {
    kind: "deliver-user-worker-exit";
    workerId: number;
    exitCode: number;
    // Phase 3c (e33+): optional packed Error info — when present,
    // parent wasm emits 'error' on the Worker before 'exit'.
    errorBytes?: Uint8Array | null;
  } | {
    kind: "deliver-message-to-child";
    bytes: Uint8Array;
  } | {
    kind: "deliver-message-from-child";
    workerId: number;
    bytes: Uint8Array;
  }) | null;
  if (data?.kind === "reverse-echo") {
    void runReverseEcho(data.bytes ?? 32);
    return;
  }
  if (data?.kind === "spawn-user-worker-reply") {
    handleMainSpawnReply(data);
    return;
  }
  if (data?.kind === "deliver-user-worker-exit") {
    deliverUserWorkerExit(data.workerId, data.exitCode, data.errorBytes ?? null);
    return;
  }
  if (data?.kind === "deliver-message-to-child") {
    deliverMessageToChild(data.bytes);
    return;
  }
  if (data?.kind === "deliver-message-from-child") {
    deliverMessageFromChild(data.workerId, data.bytes);
    return;
  }
  // P3.9: structured-clone IPC port (one half of a MessageChannel from
  // main; the other half is on the wasm runtime worker). This port
  // delivers parent->child cp.send(msg) values with FULL postMessage
  // structured-clone fidelity (Map, Set, Date, ArrayBuffer, circular
  // refs all preserved). Routes per-childId to the matching executor's
  // opts.ipc message handlers; sends from the executor go back via the
  // same port. Activates when spawn(..., { serialization: 'advanced' }).
  if ((data as { kind?: string })?.kind === "edge-ipc-structured-port") {
    const port = (data as { port: MessagePort }).port;
    attachIpcStructuredPort(port);
    return;
  }
  if (!data || data.kind !== "init") return;
  if (server !== null) {
    log("init received twice; ignoring second", "warn");
    return;
  }
  hostWorkerId = data.hostWorkerId ?? 0;
  if (!data.requestSab || !data.replySab || !data.reverseRequestSab || !data.reverseReplySab) {
    log("init missing one of (request|reply|reverseRequest|reverseReply)Sab", "err");
    return;
  }
  if (!data.sharedWakeSab) {
    log("init missing sharedWakeSab", "err");
    return;
  }
  try {
    requestRing = attachRing(data.requestSab, RING_CONFIG);
    replyRing = attachRing(data.replySab, RING_CONFIG);
    reverseRequestRing = attachRing(data.reverseRequestSab, RING_CONFIG);
    reverseReplyRing = attachRing(data.reverseReplySab, RING_CONFIG);
  } catch (err) {
    log(`attachRing failed: ${(err as Error).message}`, "err");
    return;
  }
  // Shared-wake view (single i32 slot at idx 0).  Both the forward-reply
  // publisher (RpcServer) and the reverse-request publisher (RpcClient)
  // bump this so a wasm-side SyncRpcClient blocked on the shared address
  // wakes for either event.  R6a / R1 findings.
  const sharedWakeI32 = new Int32Array(data.sharedWakeSab);
  const sharedWake = { i32: sharedWakeI32, idx: 0 };
  server = new RpcServer(requestRing, replyRing, sharedWake);
  registerHandlers(server);
  // Reverse-channel client (host -> wasm).  Used by L5+ for finalizers
  // and threadsafe function dispatch.  No handlers needed on host's
  // side of this channel — replies route via requestId demux as usual.
  reverseClient = new RpcClient(reverseRequestRing, reverseReplyRing, sharedWake);
  // F-9 path-a: sync variant on the same rings.  Callback-arg op
  // handlers consume this via getHostSideReverseSyncClient() to build
  // synchronous closures (emnapi's withScope does not await).
  hostSideReverseSyncClient = new SyncRpcClient(
    reverseRequestRing,
    reverseReplyRing,
    sharedWake,
    // No drainReverseRequests — the host is the SENDER on this channel;
    // there is no further reverse direction from here.
    null,
  );
  // Eval the deployment's bootScript (if any) BEFORE marking ready and
  // BEFORE starting the RPC drain loop. This guarantees any executor
  // hooks the bootScript installs (e.g. __edgeChildProcessExecutor)
  // are in place by the time the first RPC arrives.
  if (typeof (data as { bootScript?: string }).bootScript === "string") {
    const src = (data as { bootScript?: string }).bootScript!;
    cachedBootScript = src;
    try {
      // eslint-disable-next-line no-new-func
      new Function(src)();
    } catch (err) {
      log(`bootScript eval failed: ${(err as Error).message}`, "err");
    }
  }
  // Start drain loop (fire-and-forget).
  void server.start().catch((err) => {
    log(`rpc-server crashed: ${(err as Error).stack ?? err}`, "err");
  });
  log("ready (forward + reverse channels both attached)");
  const ready: ReadyMessage = {
    kind: "ready",
    hostWorkerId,
    napiMemorySab: getNapiMemorySab() ?? undefined,
  };
  self.postMessage(ready);
});
}
