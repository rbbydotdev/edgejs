// Child-thread Worker entry — receives a "load" message with the shared
// wasm Module + SAB-backed Memory from the main worker (via ThreadManager),
// instantiates its OWN WebAssembly.Instance against them, then on "start"
// runs __wasm_init_tls(tls_base) + wasi_thread_start(tid, startArg).
//
// The instance is per-worker, so __tls_base / __tls_size globals are
// per-instance globals, AND the malloc that backs the TLS region happens
// in the child's context — every C-side `__thread` variable in edge.js
// (errno, OpenSSL per-thread state, libuv per-thread caches) gets its own
// region instead of aliasing across workers.
//
// WHY A SEPARATE FILE (NOT REUSE worker.ts)
//
// Main worker.ts handles the full edge.js boot: emnapi context creation,
// napi-host setup, policies, FS facade, HTTP bridge.  Child threads need
// NONE of that — they re-instantiate the wasm module against the existing
// memory and run a single function.  Reusing worker.ts would either crash
// (double-init of singletons) or pay the full boot cost per thread.

import { buildImports } from "./imports-generated";
import { createWasiShim } from "./wasi-shim";
import { syncYieldStrategy } from "./wasi-shim/yield-sync";
import { ThreadMessageHandler, type WASIInstance } from "./napi-host/emnapi";
import { createBundledFs } from "./host/fs/adapters/bundled";

declare const self: DedicatedWorkerGlobalScope;

function postLog(text: string, level: "info" | "warn" | "err" = "info") {
  self.postMessage({ kind: "thread-log", text, level });
}

// Minimal WASIInstance shim: ThreadMessageHandler calls instance.exports
// directly via __wasm_init_tls / wasi_thread_start in its _start path,
// but it still calls our `wasi.initialize` / `wasi.start` for the side
// effect of setting any "ready" flag.  We satisfy the interface with
// no-ops because our wasi-shim doesn't have a separate initialize stage.
const wasiStub: WASIInstance = {
  wasiImport: undefined,
  initialize(_instance: object) { void _instance; },
  start(_instance: object): number { void _instance; return 0; },
  getImportObject(): { wasi: Record<string, Function> } {
    return { wasi: {} };
  },
};

// One handler per child thread; created on first message receipt.
new ThreadMessageHandler({
  postMessage: (msg) => self.postMessage(msg),
  // Override the default instantiate so we use OUR wasi-shim + napi
  // namespace split, not emnapi's defaults.
  onLoad: async (payload) => {
    const { wasmModule, wasmMemory } = payload;
    postLog(`[thread] load received, instantiating against shared memory`);

    // Build wasi imports for this thread.  Sync yield strategy — child
    // threads don't drive the microtask pump; they just do work.
    // FS adapter: bundled (read-only).  Threads don't need OPFS yet.
    const fs = createBundledFs({ log: () => { /* quiet */ } });
    const shim = createWasiShim({
      memory: wasmMemory,
      args: ["edge-thread"],
      env: {},
      fs,
      postLog: (text, level) => postLog(text, (level === "out" || level === "err" || level === "warn") ? (level === "out" ? "info" : level) : "info"),
      postExit: () => { /* threads don't drive process.exit */ },
      yieldStrategy: syncYieldStrategy,
    });

    // Napi imports for child threads are STUBS — child threads run wasm
    // that uses libc TLS, OpenSSL, etc., but they don't drive their own
    // emnapi context.  Falling through to the generated default-return
    // stubs (return 0) is correct here: any napi call from a worker
    // thread that depends on env state would already be undefined behavior.
    const wasmImports = buildImports(wasmMemory, {
      napi: undefined,
      napi_extension_wasmer_v0: undefined,
      env: undefined,
      wasi_snapshot_preview1: shim.wasi_snapshot_preview1 as Record<string, Function>,
      wasix_32v1: shim.wasix_32v1 as Record<string, Function>,
      wasi: shim.wasi,
    }, () => { /* trace off for child threads */ });
    (wasmImports.env as Record<string, unknown>).memory = wasmMemory;

    const instance = await WebAssembly.instantiate(wasmModule, wasmImports);

    // Per-thread TLS init.  `__wasm_init_tls(tls_base)` writes the
    // thread's __tls_base global (per-instance) and zeroes/copies the
    // TLS template into the new region.  The region itself is allocated
    // by emnapi's wasi-threads, which calls our wasm's `malloc` for the
    // tls_size bytes BEFORE invoking wasi_thread_start.
    //
    // ThreadMessageHandler does the actual __wasm_init_tls + wasi_thread_start
    // calls itself — we just have to return the right instance shape.
    return { instance, module: wasmModule };
  },
});

// Tell main we're ready.  ThreadManager waits for this before considering
// the worker available for the pool.
self.postMessage({ kind: "thread-ready" });
postLog("[thread] worker spawned, awaiting load");

void wasiStub;
