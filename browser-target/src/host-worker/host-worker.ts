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
  type RingConfig,
} from "../wasi-shim/sab-ring";
import { RpcServer } from "./rpc-server";
import { RpcClient } from "./rpc-client";
import {
  OP_PING,
  OP_HOST_READY,
  OP_HOST_ECHO,
  OP_RUN_USER_SCRIPT,
  OP_NAPI_GET_UNDEFINED,
  OP_NAPI_GET_NULL,
  OP_NAPI_GET_GLOBAL,
  REPLY_STATUS_OK,
  REPLY_STATUS_HOST_ERROR,
  REPLY_STATUS_INVALID_ARGS,
} from "./rpc-protocol";
// F-1: emnapi context on host worker.  Imports via the project facade
// (single swap point for v1 vs v2 — see plans/lever-b-l5-options.md
// "v1 vs v2" finding).
import { createContext, createNapiModule } from "../napi-host/emnapi";

declare const self: DedicatedWorkerGlobalScope;

// Must match the producer's config (in worker-pool.ts).
const RING_CONFIG: RingConfig = {
  numSlots: 32,
  slotSize: 4 * 1024,
};

interface InitMessage {
  kind: "init";
  requestSab: SharedArrayBuffer;
  replySab: SharedArrayBuffer;
  reverseRequestSab: SharedArrayBuffer;
  reverseReplySab: SharedArrayBuffer;
  hostWorkerId: number;
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

// F-1: emnapi state.  Initialized lazily on first napi op so we don't
// pay the cost when only ping/echo are used.  Memory is the SAB shared
// with the wasm worker — wired in F-2.  For F-1 we use a host-local
// memory so we can probe the napi handlers end-to-end without needing
// the real wasm bridging.
let napiCtx: ReturnType<typeof createContext> | null = null;
let napiModuleHost: ReturnType<typeof createNapiModule> | null = null;
let napiHostMemory: WebAssembly.Memory | null = null;
function ensureNapiContext(): void {
  if (napiCtx) return;
  napiCtx = createContext();
  // F-1: stub instance.  F-2 replaces with the real shared memory.
  napiHostMemory = new WebAssembly.Memory({ initial: 1, maximum: 16, shared: true });
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
        poolNext += (size + 7) & ~7;
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
  log(`napi context ready; ${Object.keys(napiModuleHost.imports.napi ?? {}).length} napi fns available`);
}

function log(text: string, level: "info" | "warn" | "err" = "info"): void {
  self.postMessage({ kind: "host-log", text: `[host-worker:${hostWorkerId}] ${text}`, level });
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
    const capturedConsole = {
      log: (...parts: unknown[]) => {
        out.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
      },
      error: (...parts: unknown[]) => {
        out.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
      },
    };
    try {
      // Wrap in async fn so we can `await` it — gives microtasks
      // queued during the script body a chance to drain BEFORE we
      // capture stdout and return the reply.  This is the same
      // pattern await-resumes-as-microtask exercises: V8 drains its
      // queue at the await boundary.
      const fn = new Function(
        "console",
        // Allow returning promises / async work.
        `return (async () => { ${source} })()`,
      );
      const ret = fn(capturedConsole);
      if (ret && typeof ret.then === "function") {
        await ret;
      }
      // One more microtask drain — for tests like `microtask-before-timer`
      // where the script's microtasks are queued from setTimeout-deferred
      // continuations.  An empty `await` here gives V8 one more checkpoint.
      await Promise.resolve();
      const payload = new TextEncoder().encode(out.join("\n"));
      return { payload, status: REPLY_STATUS_OK };
    } catch (e) {
      const msg = (e instanceof Error ? e.stack ?? e.message : String(e)) || "user script threw";
      const payload = new TextEncoder().encode(out.join("\n") + "\n\nERROR: " + msg);
      return { payload, status: REPLY_STATUS_HOST_ERROR };
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

self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as (Partial<InitMessage> | ReverseEchoMessage) | null;
  if (data?.kind === "reverse-echo") {
    void runReverseEcho(data.bytes ?? 32);
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
  try {
    requestRing = attachRing(data.requestSab, RING_CONFIG);
    replyRing = attachRing(data.replySab, RING_CONFIG);
    reverseRequestRing = attachRing(data.reverseRequestSab, RING_CONFIG);
    reverseReplyRing = attachRing(data.reverseReplySab, RING_CONFIG);
  } catch (err) {
    log(`attachRing failed: ${(err as Error).message}`, "err");
    return;
  }
  server = new RpcServer(requestRing, replyRing);
  registerHandlers(server);
  // Reverse-channel client (host -> wasm).  Used by L5+ for finalizers
  // and threadsafe function dispatch.  No handlers needed on host's
  // side of this channel — replies route via requestId demux as usual.
  reverseClient = new RpcClient(reverseRequestRing, reverseReplyRing);
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
