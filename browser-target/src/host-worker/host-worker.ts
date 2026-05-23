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
// F-4: bulk-register read-only napi op handlers.
import { makeNapiOpRegistry } from "./napi-op-handlers";

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
