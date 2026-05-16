# Internal N-API Promises Refactor

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Promise and microtask logic lives in `napi_promises__`; native QuickJS and V8 suites pass. |
| **Severity** | High | Promise hooks and rejection tracking must behave consistently for native QuickJS N-API. |

## Scope

Move QuickJS N-API promise hook, promise rejection tracker, microtask job, and
continuation-preserved embedder data state into:

```text
napi/quickjs/src/internal/napi_promises.h
napi/quickjs/src/internal/napi_promises.cc
```

The class must be named `napi_promises__`, and `napi_env__` should own a direct
object of that class rather than storing individual promise fields.

## Current State

- `napi_promises.{h,cc}` contains class `napi_promises__`.
- `napi_env__` owns a direct `napi_promises__ promises_` object and no longer
  stores individual promise hook, rejection callback, microtask, or continuation
  embedder data fields.
- `unofficial_napi.cc` calls `env->promises()` and delegates to
  `napi_promises__::promise_hook`, `napi_promises__::rejection_tracker`, and
  `napi_promises__::microtask_job`.
- Runtime promise hook and rejection tracker wiring is now owned by
  `napi_promises__`; `unofficial_napi.cc` delegates attach/update/clear calls
  instead of calling `JS_SetPromiseHook(...)` and
  `JS_SetHostPromiseRejectionTracker(...)` directly.
- Continuation-preserved embedder data now covers both ordinary promise
  reactions and async-function `await` resumptions. The vendored QuickJS
  `promise_reaction_job(...)` recovers hook identity from resolving functions
  first, then from the async-function reaction `handler` when the thrownaway
  capability slots are `undefined`.
- Captured frames are released on promise fulfilment or rejected-promise
  tracking, not immediately on `AFTER`, so a multi-`await` async function keeps
  the same request frame across every resume.
- `quickjs/CMakeLists.txt` builds `src/internal/napi_promises.cc`.
- The earlier separate microtask files have been removed after all references
  were eliminated.
- The rejection handled callback keeps the V8-shaped event payload: event `1`
  passes `undefined` as the reason.
- `PromiseHooksObserveLifecycleEvents` uses a thenable because stock QuickJS
  emits before/after hooks for thenable resolution jobs, not for ordinary
  already-resolved promise reactions.
- `PromiseReactionRestoresContinuationPreservedEmbedderData` and
  `AsyncAwaitRestoresContinuationPreservedEmbedderData` cover request-frame
  restoration across promise jobs and consecutive `await` resumptions.

## Verification

Run from `/Users/sadhbh/src/dev/edgejs/napi`:

```sh
make test-native-quickjs
make test-native-v8
```

Completed on May 16, 2026:

```sh
cd /Users/sadhbh/src/dev/edgejs/napi && make test-native-quickjs
```

Result: 67/67 tests passed, including the promise hook, rejection callback,
promise reaction, and async/await continuation coverage.

Also run because the promise test is shared:

```sh
cd /Users/sadhbh/src/dev/edgejs/napi && make test-native-v8
```

Result: 45/45 tests passed.
