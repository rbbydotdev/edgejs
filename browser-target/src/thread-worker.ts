// Child-thread Worker entry — receives `load` + `start` messages from the
// main worker (via emnapi's ThreadManager protocol), instantiates its OWN
// WebAssembly.Instance against the shared Module + Memory, then calls
// `wasi_thread_start(tid, arg)` to run the user's thread function.
//
// The instance is per-worker, so `__tls_base` / `__tls_size` globals are
// per-instance globals AND `wasi_thread_start`'s prologue allocates a fresh
// TLS region in shared linear memory.  Every C-side `__thread` variable in
// edge.js (errno, OpenSSL per-thread error state, libuv per-thread caches)
// gets its own region instead of aliasing across workers.
//
// WHY A SEPARATE FILE
//
// Main worker.ts handles full edge.js boot: emnapi context, napi-host,
// policies, FS facade, HTTP bridge.  Child threads need NONE of that — they
// re-instantiate the wasm module against existing memory and call one
// function.  Reusing worker.ts would either crash (double-init of
// singletons) or pay the full boot cost per thread.
//
// PROTOCOL (emnapi/wasi-threads ThreadManager ↔ ThreadMessageHandler)
//
//   main → child:   { __emnapi__: { type: 'load',  payload: { wasmModule, wasmMemory, sab } } }
//   child → main:   { __emnapi__: { type: 'loaded', payload: {} } }
//   main → child:   { __emnapi__: { type: 'start', payload: { tid, arg, sab } } }
//   child:          calls instance.exports.wasi_thread_start(tid, arg)
//   child → main:   { __emnapi__: { type: 'cleanup-thread', payload: { tid } } }   (when start returns)
//
// The TLS init (`__wasm_init_tls(tls_base)`) happens INSIDE wasm's own
// wasi_thread_start prologue — we don't call it from JS.

import { buildImports } from "./imports-generated";
import { createWasiShim } from "./wasi-shim";
import { syncYieldStrategy } from "./wasi-shim/yield-sync";
import { ThreadMessageHandler, WASIThreads, type WASIInstance } from "./napi-host/emnapi";
import { createBundledFs } from "./host/fs/adapters/bundled";
import { PipeRegistry } from "./wasi-shim/pipes-sab";
import { FsSnapshotRegistry } from "./wasi-shim/fs-snapshot-sab";

declare const self: DedicatedWorkerGlobalScope;

function postLog(text: string, level: "info" | "warn" | "err" = "info") {
  self.postMessage({ kind: "thread-log", text, level });
}

// SABs handed to us by main BEFORE the emnapi load message (see
// worker.ts onCreateWorker).  Stash them so onLoad's wasi-shim attaches
// to the same cross-thread state.  Without these, any pipe / file op
// the pool worker performs lives in a different memory than main's.
let pipeRegistry: PipeRegistry | undefined;
let fsSnapshot: FsSnapshotRegistry | undefined;
self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as { kind?: string; sab?: SharedArrayBuffer } | null;
  if (data?.kind === "edge-pipe-sab" && data.sab) {
    pipeRegistry = PipeRegistry.attach(data.sab);
  } else if (data?.kind === "edge-fs-snapshot-sab" && data.sab) {
    fsSnapshot = FsSnapshotRegistry.attach(data.sab);
  }
});


// Wrap the global onmessage handler with diagnostic logging so we can
// trace the load/start protocol.
const handler = new ThreadMessageHandler({
  postMessage: (msg) => self.postMessage(msg),
  onLoad: async ({ wasmModule, wasmMemory }): Promise<WebAssembly.WebAssemblyInstantiatedSource> => {
    postLog(`[thread] load received, instantiating against shared memory`);

    // Build wasi imports for this thread.  Sync yield — child threads
    // don't drive a microtask pump.  FS is bundled (read-only); threads
    // don't need OPFS for typical work.
    const fs = createBundledFs({ log: () => { /* quiet */ } });
    const shim = createWasiShim({
      memory: wasmMemory,
      args: ["edge-thread"],
      env: {},
      fs,
      postLog: (text, level) => {
        const lvl = level === "out" ? "info" : level === "err" || level === "warn" ? level : "info";
        postLog(text, lvl as "info" | "warn" | "err");
      },
      postExit: () => { /* threads don't drive process.exit */ },
      yieldStrategy: syncYieldStrategy,
      pipeRegistry,
      fsSnapshot,
      fsSnapshotRole: "reader",
    });

    // Child-side WASIThreads stub.  Required by emnapi protocol:
    // the child must run wasiThreads.initialize(originalInstance, ...)
    // — NOT just return the raw instance — so the wasi-threads layer
    // hooks up per-thread state (TLS init via __wasm_init_tls, futex
    // routing, etc.).  Without this the spawn succeeds but TLS aliases
    // across threads (the exact bug we set out to fix).
    //
    // childThread: true puts WASIThreads in passive mode — no Worker
    // factory, no ThreadManager.  It just provides the namespace and
    // does the initialize() side-effects.
    const wasiStub: WASIInstance = {
      wasiImport: undefined,
      initialize(_i: object) { void _i; },
      start(_i: object): number { void _i; return 0; },
      getImportObject(): { wasi: Record<string, Function> } { return { wasi: shim.wasi }; },
    };
    const wasiThreads = new WASIThreads({
      wasi: wasiStub,
      childThread: true,
    });

    // Napi imports for child threads are stubs.  Child threads run wasm
    // that uses libc/__thread/OpenSSL TLS — they don't drive their own
    // emnapi context.  Default-return stubs in buildImports (napi=0) are
    // correct here: any napi call from a worker thread that depends on
    // env state would already be undefined behavior in real Node too
    // (you can't share napi_env across threads without an explicit
    // threadsafe-function ref).
    const wasmImports = buildImports(wasmMemory, {
      wasi_snapshot_preview1: shim.wasi_snapshot_preview1 as Record<string, Function>,
      wasix_32v1: shim.wasix_32v1 as Record<string, Function>,
      wasi: { ...shim.wasi, ...wasiThreads.getImportObject().wasi },
    }, () => { /* trace off in production */ });
    (wasmImports.env as Record<string, unknown>).memory = wasmMemory;

    const originalInstance = await WebAssembly.instantiate(wasmModule, wasmImports);
    const instance = wasiThreads.initialize(originalInstance, wasmModule, wasmMemory);
    postLog(`[thread] instantiated + initialized, awaiting start`);
    return { instance, module: wasmModule };
  },
  onError: (err, type) => {
    postLog(`[thread] error in ${type}: ${err.message ?? String(err)}`, "err");
  },
});

self.onmessage = (e: MessageEvent) => {
  // ThreadMessageHandler.handle expects a strongly-typed
  // WorkerMessageEvent<...> but its runtime check is duck-typed
  // (`e?.data?.__emnapi__`), so the cast is safe.
  handler.handle(e as never);
};
