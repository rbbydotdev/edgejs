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

import type { Context } from "@emnapi/runtime";

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
     * "Drain pending microtasks now."  In real Node this calls
     * `Isolate::PerformMicrotaskCheckpoint()` to force-drain V8's
     * queue.  Our model: V8's queue IS the host's, and host V8 drains
     * it naturally at task boundaries — we don't have a sync force-drain
     * primitive from JS-land.  Return napi_ok; the practical effect is
     * "microtasks will drain when control returns to host", which is
     * what edge's wasm code typically needs anyway.
     */
    unofficial_napi_process_microtasks(_env: number): number {
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
