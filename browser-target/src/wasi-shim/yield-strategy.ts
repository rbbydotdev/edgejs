// YieldStrategy — how the wasi-shim's blocking-style syscalls bridge to
// the host's async machinery so promise-based host code (CompressionStream,
// fetch, postMessage) can make progress while edge.js's wasm event loop is
// running.
//
// Three implementations live in sibling files:
//   - yield-sync.ts — current behavior (no yield; `Atomics.wait` blocks
//     the JS thread).  For Node v22, browsers without JSPI, and any env
//     where we don't want to pay the suspend cost.  Microtasks queued by
//     host async code DON'T drain until `_start` returns.
//   - yield-jspi.ts — uses native `WebAssembly.Suspending` /
//     `WebAssembly.promising`.  Zero wasm-side cost, the engine handles
//     stack switching.  Requires Node v24+ (`--experimental-wasm-jspi`)
//     or Chrome 137+.
//   - yield-asyncify.ts (future) — drives `wasm-opt --asyncify`
//     instrumentation from JS.  For Safari and old Firefox until they
//     ship JSPI.  Requires an Asyncify-instrumented wasm artifact.
//
// SELECTION
//
// Picked at instantiation time by feature-detection (typically in the
// harness; browsers will do the analogous detection).  Dynamic import
// keeps the unused coordinator code out of the bundle:
//
//   if (typeof WebAssembly.Suspending === "function") {
//     return (await import("./yield-jspi")).jspiYieldStrategy;
//   }
//   return (await import("./yield-sync")).syncYieldStrategy;

/** Signature of the sync poll_oneoff impl (today's behavior). */
export type SyncPollOneoff = (
  inPtr: number,
  outPtr: number,
  nsubs: number,
  neventsPtr: number,
) => number;

/** Signature of the async-capable poll_oneoff impl.  May return a
 *  `Promise<number>` (engine suspends wasm) OR a sync `number` (no
 *  suspend, fast-path for events-ready). */
export type AsyncCapablePollOneoff = (
  inPtr: number,
  outPtr: number,
  nsubs: number,
  neventsPtr: number,
) => number | Promise<number>;

/** Signature of the sync futex_wait impl. */
export type SyncFutexWait = (futexPtr: number, expected: number, timeoutPtr: number) => number;

/** Signature of the async-capable futex_wait impl.  Returns either
 *  the i32 result immediately, or a Promise that resolves to the i32
 *  once the wait completes. */
export type AsyncCapableFutexWait = (futexPtr: number, expected: number, timeoutPtr: number) => number | Promise<number>;

export interface YieldStrategy {
  /** Identifier for logging / diagnostic; matches the filename. */
  readonly name: "sync" | "jspi" | "asyncify";

  /** Build the wasm-import function for `poll_oneoff`.
   *  The wasi-shim provides BOTH a fully-sync impl (uses `Atomics.wait`)
   *  and an async-capable impl (uses `await setTimeout` for timer-only).
   *  Each strategy picks which to expose, and applies any engine-side
   *  wrapping (e.g. `WebAssembly.Suspending`). */
  wrapPollOneoff(
    syncImpl: SyncPollOneoff,
    asyncImpl: AsyncCapablePollOneoff,
  ): Function;

  /** Build the wasm-import function for `futex_wait`.
   *  Same shape as wrapPollOneoff — sync strategy returns the sync impl
   *  (`Atomics.wait` blocks the thread; fine for dedicated workers,
   *  blocks event loop for main); JSPI strategy returns a
   *  `WebAssembly.Suspending` wrap around the async impl so the wasm
   *  suspends without blocking host microtasks/macrotasks. */
  wrapFutexWait(
    syncImpl: SyncFutexWait,
    asyncImpl: AsyncCapableFutexWait,
  ): Function;

  /** Wrap a wasm export (typically `_start`) so callers can drive it
   *  in a way the strategy supports.
   *  - sync: returns the export as-is (callers call it synchronously).
   *  - jspi: returns a `WebAssembly.promising` wrapper (callers `await`
   *    the result; mid-execution Suspending-import calls cause the wasm
   *    to suspend without blocking the JS thread).
   *  - asyncify: returns a coordinator that re-enters the export through
   *    the unwind/rewind machinery. */
  wrapExport(fn: Function): Function;
}
