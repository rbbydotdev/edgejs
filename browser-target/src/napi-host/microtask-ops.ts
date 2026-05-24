// Host-side implementations of the `unofficial_napi_*` microtask /
// promise-hook ops that edge's C++ calls via the
// `napi_extension_wasmer_v0` import module (per the
// `NAPI_EXTENSION_WASMER_EXTERN` attribute in
// `napi/include/unofficial_napi.h`).
//
// These functions REPLACE the V8-statically-linked impls (which fail
// under emnapi because they require a real `env->isolate`).  When edge's
// wasm is built with `__attribute__((used))` referencing the four symbols
// (see `src/edge_task_queue.cc` force-keep block), wasm-ld emits them as
// real wasm imports and routes to these host impls.
//
// LAYER: L1 (wasm imports).  More authoritative than the L3
// `installTaskQueueEnqueueShim` and L4 `task-queue-enqueue-fix` policy
// — once the rebuild lands and these imports are wired, those shims
// should be dropped.
//
// ABI (from `napi/include/unofficial_napi.h`):
//
//   napi_status unofficial_napi_enqueue_microtask(napi_env env, napi_value callback);
//   napi_status unofficial_napi_process_microtasks(napi_env env);
//   napi_status unofficial_napi_set_promise_reject_callback(napi_env env, napi_value callback);
//   napi_status unofficial_napi_set_promise_hooks(napi_env env, napi_value init, napi_value before, napi_value after, napi_value resolve);
//
// Each takes wasm-side handle IDs (uint32 napi values) and returns a
// uint32 napi_status (0 = napi_ok).

import type { Context } from "./emnapi";

const NAPI_OK = 0;
const NAPI_INVALID_ARG = 1;

/**
 * State captured by these ops for delivery / inspection.  Lives on the
 * host side so it survives across wasm calls and isn't affected by
 * edge's wasm-side state-machine quirks.
 */
export interface MicrotaskOpsState {
  /** Most recently registered lib promise-reject handler.  Invoked by
   *  our `unhandledrejection` listener (`installTaskQueueEnqueueShim` in
   *  index.ts).  Re-registering replaces. */
  promiseRejectCallback: ((type: number, promise: unknown, reason: unknown) => void) | null;
  /** Most recently registered lib promise-lifecycle hooks.  Stored but
   *  not currently driven — would require V8 PerformMicrotaskCheckpoint
   *  visibility we don't have at the host. */
  promiseHooks: {
    init: ((promise: unknown, parent: unknown) => void) | null;
    before: ((promise: unknown) => void) | null;
    after: ((promise: unknown) => void) | null;
    resolve: ((promise: unknown) => void) | null;
  };
}

export function createMicrotaskOpsState(): MicrotaskOpsState {
  return {
    promiseRejectCallback: null,
    promiseHooks: { init: null, before: null, after: null, resolve: null },
  };
}

/**
 * Build the napi_extension_wasmer_v0 import namespace.
 *
 * Returns an object suitable to compose into
 * `wasmImports.napi_extension_wasmer_v0`.  All four ops take napi_value
 * arguments (uint32 wasm-side handle IDs) and return napi_status (uint32).
 */
export function buildMicrotaskOpsImports(
  context: Context,
  state: MicrotaskOpsState,
): Record<string, Function> {
  // Captured at module load — see host/globals-shim.ts.  Edge's bootstrap
  // overwrites globalThis.queueMicrotask with lib's wrapper that calls
  // back into the broken binding; we use the host native directly.
  const hostQueueMicrotask = globalThis.queueMicrotask?.bind(globalThis);

  function resolveValue(handleId: number): unknown {
    if (!handleId) return undefined;
    return context.handleStore.get(handleId)?.value;
  }

  return {
    /**
     * Enqueue a JS function onto the microtask queue.  Replaces the V8
     * `Isolate::EnqueueMicrotask` path — we route to the host's V8
     * microtask queue (which is THE microtask queue all our JS runs on).
     */
    unofficial_napi_enqueue_microtask(_env: number, callbackId: number): number {
      if (!hostQueueMicrotask) return NAPI_INVALID_ARG;
      const callback = resolveValue(callbackId);
      if (typeof callback !== "function") return NAPI_INVALID_ARG;
      hostQueueMicrotask(callback as () => void);
      return NAPI_OK;
    },

    /**
     * "Drain pending microtasks now."  Edge's main loop calls this once
     * per iteration (`src/edge_runtime.cc:1870`) expecting V8's
     * `Isolate::PerformMicrotaskCheckpoint()` semantics.
     *
     * Implementation: invoke host Node's `process._tickCallback` (if
     * available) which internally calls
     * `internalBinding('task_queue').runMicrotasks` — the JS-visible
     * path to PerformMicrotaskCheckpoint.  Snapshot captured by
     * `host/globals-shim.ts` BEFORE edge replaces the `process` global.
     *
     * On JSPI-enabled engines (Chrome 137+, Node v24+) the real
     * microtask drain happens at the JSPI suspend boundary in the
     * Suspending-wrapped poll_oneoff (see `wasi-shim.ts`) — the engine
     * runs a microtask checkpoint each time wasm yields back to JS.
     * This handler becomes a complementary catch-all for the rare wasm
     * code path that calls `unofficial_napi_process_microtasks` without
     * also yielding through a suspending import.
     *
     * Browser-worker without JSPI / Node v22 fallback: the snapshot is
     * either null (Worker) or scope-guarded (depth > 0 inside
     * InternalCallbackScope), so this is best-effort.  The two
     * regression bugs (lazy-load-from-microtask,
     * microtasks-starved-by-pending-timer) only close under JSPI.
     *
     * E23-redo: wrapping this op as `WebAssembly.Suspending` to force
     * a microtask checkpoint (the obvious fix for the
     * microtask-before-timer ordering bug) does NOT work — the engine
     * throws SuspendError when JS frames sit between the promising
     * entry (`_start`) and this Suspending import, which is the case
     * at most of the call sites (`edge_runtime.cc:3034` via
     * `napi_call_function`, `edge_task_queue.cc:94` via task_queue's
     * `runMicrotasks` binding called from lib's
     * `processTicksAndRejections`).  Suspending wrap is all-or-nothing
     * once installed; can't gate dynamically.
     *
     * Fixes that WOULD work all require a wasm rebuild:
     *   1. New separate import (e.g. `unofficial_napi_yield_for_microtasks`)
     *      used ONLY at the safe call site (`edge_runtime.cc:1870`,
     *      wasm-only stack between uv_run iterations).  Only that
     *      import gets the Suspending wrap.
     *   2. Insert microtask-drain BEFORE timers fire at the top of
     *      `RunEventLoopUntilQuiescent`'s loop body (wasm-only stack).
     *   3. Asyncify / emnapi multithreaded — NOTES followup #1.
     *
     * For now: `host=1` is the workaround for the 3 affected tests
     * (microtask-before-timer, nexttick-before-microtask,
     * promise-chain-drains-fully).  See
     * `experiments/e23-redo-microtask-drain/FINDINGS.md`.
     */
    unofficial_napi_process_microtasks(_env: number): number {
      const tickCb = (globalThis as { __edgeHostTickCallback?: (() => void) | null }).__edgeHostTickCallback;
      if (typeof tickCb === "function") {
        try { tickCb(); }
        catch { /* swallow: host-side tick errors must not break wasm */ }
      }
      return NAPI_OK;
    },

    /**
     * Register lib's PromiseReject handler.  Replaces edge's V8
     * `SetPromiseRejectCallback` path — we capture the JS callback into
     * `state.promiseRejectCallback`, and the host-side
     * `unhandledrejection` listener (wired in `installTaskQueueEnqueueShim`)
     * forwards real promise-rejection events to it.
     *
     * Lib's callback signature: `(type, promise, reason)` where type is
     * 0 = kPromiseRejectWithNoHandler, 1 = kPromiseHandlerAddedAfterReject,
     * 2 = kPromiseRejectAfterResolved, 3 = kPromiseResolveAfterResolved.
     */
    unofficial_napi_set_promise_reject_callback(_env: number, callbackId: number): number {
      const callback = resolveValue(callbackId);
      if (typeof callback !== "function") {
        // null/undefined unregisters — match the C++ binding semantics.
        if (!callbackId) {
          state.promiseRejectCallback = null;
          return NAPI_OK;
        }
        return NAPI_INVALID_ARG;
      }
      state.promiseRejectCallback = callback as (t: number, p: unknown, r: unknown) => void;
      return NAPI_OK;
    },

    /**
     * Register lib's Promise lifecycle hooks (init/before/after/resolve).
     * Replaces edge's V8 `SetPromiseHooks` path.  We capture the callbacks
     * into state but don't currently DRIVE them — that requires V8's
     * PerformMicrotaskCheckpoint integration we don't have host-side.
     *
     * Stored for diagnostic visibility; once we have a way to drive them
     * (e.g. via a Performance Observer of microtask boundaries, or
     * eventual v-table-mode integration), we can wire them up without
     * changing the wasm-side ABI.
     */
    unofficial_napi_set_promise_hooks(_env: number, initId: number, beforeId: number, afterId: number, resolveId: number): number {
      function asFn(id: number) {
        const v = resolveValue(id);
        return typeof v === "function" ? v as (...a: unknown[]) => unknown : null;
      }
      state.promiseHooks = {
        init: asFn(initId) as MicrotaskOpsState["promiseHooks"]["init"],
        before: asFn(beforeId) as MicrotaskOpsState["promiseHooks"]["before"],
        after: asFn(afterId) as MicrotaskOpsState["promiseHooks"]["after"],
        resolve: asFn(resolveId) as MicrotaskOpsState["promiseHooks"]["resolve"],
      };
      return NAPI_OK;
    },
  };
}

/**
 * Wire host promise-rejection events to lib's captured callback.
 *
 * Lib registers its handler via `setPromiseRejectCallback`, which goes
 * through edge's C++ binding → `unofficial_napi_set_promise_reject_callback`
 * wasm import → `state.promiseRejectCallback`.  Host-level events
 * (`process.on('unhandledRejection')` on Node, `addEventListener('unhandledrejection')`
 * in browser workers) are then forwarded here.
 *
 * Lib's callback signature: `(type, promise, reason)` where type is:
 *   0 kPromiseRejectWithNoHandler
 *   1 kPromiseHandlerAddedAfterReject
 *   2 kPromiseRejectAfterResolved
 *   3 kPromiseResolveAfterResolved
 *
 * Install once at napi-host setup; both Node and browser-worker shapes
 * are supported (we hook whichever exists).
 */
export function installHostPromiseRejectListeners(
  state: MicrotaskOpsState,
  postLog?: (line: string, level: "out" | "warn" | "err" | "debug") => void,
): void {
  function dispatch(type: number, promise: unknown, reason: unknown): void {
    const cb = state.promiseRejectCallback;
    if (!cb) return;
    // Step 1: hand the rejection to lib's promiseRejectHandler — pushes
    // onto pendingUnhandledRejections, sets hasRejectionToWarn.
    try { cb(type, promise, reason); }
    catch (e) { postLog?.(`[promise-reject] lib handler threw: ${(e as Error)?.message}`, "warn"); }
    // Step 2: drain the wasm-side nextTick/rejection queue now.
    //
    // Without this, lib's queued rejection sits in pendingUnhandledRejections
    // until the next libuv callback's EdgeRunCallbackScopeCheckpoint fires —
    // which can be 100s of ms later if the only scheduled work is a
    // setTimeout.  Real Node fires unhandledRejection within the same task
    // as the rejection because V8 calls the per-isolate reject callback
    // from inside the microtask checkpoint, AND Node's microtask
    // checkpoint is followed by InternalCallbackScope's tick drain.
    //
    // On the wasm path, the V8 reject callback fires asynchronously (the
    // 'unhandledrejection' macrotask event on the worker; see HTML spec
    // "notify about rejected promises").  We're now in that event handler,
    // outside any wasm callback scope.  Call lib's tick callback
    // (process._tickCallback, registered via setTickCallback during
    // bootstrap) to flush pendingUnhandledRejections immediately — same
    // emission point Node's native InternalCallbackScope would hit.
    try {
      const proc = (globalThis as { process?: { _tickCallback?: () => void } }).process;
      if (proc && typeof proc._tickCallback === "function") {
        proc._tickCallback();
      }
    } catch (e) {
      postLog?.(`[promise-reject] tick drain threw: ${(e as Error)?.message}`, "warn");
    }
  }
  const proc = (globalThis as { process?: { on?: (event: string, fn: (...a: unknown[]) => void) => void } }).process;
  if (proc && typeof proc.on === "function") {
    proc.on("unhandledRejection", (reason: unknown, promise: unknown) => dispatch(0, promise, reason));
    proc.on("rejectionHandled", (promise: unknown) => dispatch(1, promise, undefined));
  }
  const gAddEvent = (globalThis as { addEventListener?: (event: string, fn: (...a: unknown[]) => void) => void }).addEventListener;
  if (typeof gAddEvent === "function") {
    gAddEvent("unhandledrejection", (event: unknown) => {
      const ev = event as { promise?: unknown; reason?: unknown };
      dispatch(0, ev.promise, ev.reason);
    });
    gAddEvent("rejectionhandled", (event: unknown) => {
      const ev = event as { promise?: unknown };
      dispatch(1, ev.promise, undefined);
    });
  }
}
