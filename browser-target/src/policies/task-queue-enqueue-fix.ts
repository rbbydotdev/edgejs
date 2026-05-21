import type { Policy } from "./index";

// Fixes the wasm-host's broken `enqueueMicrotask` binding.
//
// PRIMARY FIX LIVES AT THE NAPI-HOST LAYER.  See
// `installTaskQueueEnqueueShim` in `src/napi-host/index.ts` — that
// intercepts the C++ binding at create-time (`napi_create_function`)
// and replaces it with a host-native shim, BEFORE any JS lib sees it.
// That's the authoritative fix.
//
// THIS POLICY IS A REDUNDANT SAFETY NET at the lib level.  It catches
// the binding via a `{ pre }` patch on `internal/process/task_queues.js`
// — useful if the napi-host create-function intercept ever misses (e.g.
// edge changes the C++ binding-publish mechanism to something we don't
// hook).  Two layers of defense for a recursion bug that's silent until
// it's fatal.
//
// THE BUG
//
// Edge's C++ `TaskQueueEnqueueMicrotask` (`src/edge_task_queue.cc:42`) is:
//
//   if (unofficial_napi_enqueue_microtask(env, argv[0]) == napi_ok) {
//     return Undefined;
//   }
//   // FALLBACK: call globalThis.queueMicrotask(argv[0]) via napi.
//
// `unofficial_napi_enqueue_microtask` is the V8 builtin
// (`napi/v8/src/unofficial_napi.cc:2198`); it requires `env->isolate`,
// which doesn't exist under emnapi.  It returns `napi_invalid_arg`.
//
// The fallback then calls `globalThis.queueMicrotask` — which resolves
// to **lib's wrapper** at `internal/process/task_queues.js:158`, whose
// only job is to call `enqueueMicrotask(boundFn)` (this very binding).
// Infinite synchronous recursion.

const PRE_PATCH = `
;(function fixTaskQueueEnqueueMicrotask() {
  // Capture the host-native queueMicrotask reference at load time.  At
  // this point in bootstrap, lib's queueMicrotask wrapper hasn't been
  // installed onto globalThis yet — so \`globalThis.queueMicrotask\` is
  // the host native (what we want).
  var hostQueueMicrotask;
  try {
    var g = (typeof globalThis !== 'undefined' && globalThis) ||
            (typeof global !== 'undefined' && global) ||
            (typeof self !== 'undefined' && self) ||
            (typeof window !== 'undefined' && window);
    hostQueueMicrotask = g && g.queueMicrotask;
  } catch (_e) { hostQueueMicrotask = undefined; void _e; }
  if (typeof hostQueueMicrotask !== 'function') return;

  var binding;
  try { binding = internalBinding('task_queue'); } catch (_e) { return; }
  if (!binding) return;

  // The napi-host-level shim may have already replaced this with a
  // host-native impl.  Detecting that is hard (no marker) and harmless
  // to overwrite — both impls do the same thing, so install ours
  // unconditionally.
  //
  // CRITICAL: do NOT keep a reference to the original \`binding.enqueueMicrotask\`
  // for any fallback path.  The original is the recursion source — if we
  // ever call it (e.g. on a "defensive" non-function input), we
  // reintroduce the very bug we're fixing.  Always go through
  // host-native or drop the call.
  binding.enqueueMicrotask = function enqueueMicrotask(callback) {
    if (typeof callback === 'function') hostQueueMicrotask(callback);
    // Non-function arg: drop silently.  Lib's queueMicrotask wrapper
    // validates the type before calling us, so this branch only fires
    // for buggy callers — we'd rather drop than crash the runtime.
  };
})();
`;

export const taskQueueEnqueueFix: Policy = {
  name: "task-queue-enqueue-fix",
  description: "Replace internalBinding('task_queue').enqueueMicrotask with a host-native queueMicrotask call, fixing the wasm-host's infinite-recursion bug.",
  builtinOverrides: {
    "internal/process/task_queues": { pre: PRE_PATCH },
  },
};
