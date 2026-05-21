import type { Policy } from "./index";

// Fixes the wasm-host's broken `enqueueMicrotask` binding.
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
//
// Infinite synchronous recursion.  Visible as
// `Maximum call stack size exceeded` on any code path that exercises
// `queueMicrotask` — e.g. `new Response('hi').text()`,
// `Promise.resolve().then(fn)` inside certain await chains, etc.
//
// Most tests pass because the workloads they exercise don't hit
// `queueMicrotask` heavily — but anything async that goes through
// streams, fetch bodies, or webstreams trips it.
//
// THE FIX
//
// Replace `internalBinding('task_queue').enqueueMicrotask` with a JS
// implementation that calls the **host's native** queueMicrotask (the
// browser worker's `globalThis.queueMicrotask`, NOT lib's wrapper).
// The bound function passed in is already an AsyncResource-wrapped
// runMicrotask thunk; the host scheduler fires it normally and the
// existing AsyncResource bookkeeping in lib still runs.
//
// HOW IT REACHES THE LIB
//
// Bootstrap order: `internal/process/task_queues.js` is loaded early.
// It captures `enqueueMicrotask` from `internalBinding('task_queue')`
// via a top-level destructure.  Our `{ pre }` patch runs INSIDE that
// module's function wrapper BEFORE the body — so when the body's
// destructure reads `internalBinding('task_queue').enqueueMicrotask`,
// it picks up our replacement.

const PRE_PATCH = `
;(function fixTaskQueueEnqueueMicrotask() {
  // Capture the host-native queueMicrotask reference at load time.
  // primordials.Reflect would be cleaner but isn't ready in module-init
  // contexts; use the live binding.
  var hostQueueMicrotask;
  try {
    var g = (typeof globalThis !== 'undefined' && globalThis) ||
            (typeof global !== 'undefined' && global) ||
            (typeof self !== 'undefined' && self) ||
            (typeof window !== 'undefined' && window);
    hostQueueMicrotask = g && g.queueMicrotask;
  } catch (_e) { hostQueueMicrotask = undefined; void _e; }
  if (typeof hostQueueMicrotask !== 'function') return;

  // CRITICAL: at this point in bootstrap, lib's queueMicrotask wrapper
  // (task_queues.js:158) HAS NOT yet been installed onto globalThis.
  // Edge installs it later via setupTaskQueue().  So
  // \`globalThis.queueMicrotask\` here is the **host native** — what we
  // want.  After bootstrap, it'll be replaced by lib's wrapper, and
  // that wrapper calls our overridden enqueueMicrotask (below) which
  // calls the captured host native.  No recursion possible.
  var binding;
  try { binding = internalBinding('task_queue'); } catch (_e) { return; }
  if (!binding) return;

  var origEnqueue = binding.enqueueMicrotask;
  binding.enqueueMicrotask = function enqueueMicrotask(callback) {
    if (typeof callback !== 'function') {
      // Defensive: defer to the original (probably throws on non-fn).
      if (typeof origEnqueue === 'function') return origEnqueue(callback);
      return;
    }
    hostQueueMicrotask(callback);
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
