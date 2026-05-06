# Edge QuickJS REPL promise hooks and microtasks

## Context

The QuickJS-backed Edge CLI could enter REPL mode only when persistent REPL
history was disabled:

```sh
NODE_REPL_HISTORY="" ./build-edge-quickjs-cli/edge
```

With normal history enabled, the prompt appeared but input was stuck. TTY tracing
showed that native TTY reads were working and bytes reached the JS stream layer,
but `readline` stayed paused. The pause came from
`lib/internal/repl/history.js`, which pauses the REPL while it initializes
persistent history.

The last observed history trace before the lock was:

```text
open a+ done
FileHandleClose finish ...
```

The expected next trace was:

```text
close a+ done
```

So the stalled point was the async continuation after:

```js
await hnd.close();
```

This made the problem look like a promise/async continuation issue rather than
a TTY or libuv read issue.

## What the colleague branch showed

The colleague branch was useful as implementation evidence, but not as a
native-CLI proof. Its `quickjs-wasm/build.sh` only builds the WASIX target with:

```sh
-DCMAKE_TOOLCHAIN_FILE=wasix/wasix-toolchain.cmake
-DEDGE_NAPI_PROVIDER=quickjs
-DEDGE_BUILD_CLI=ON
```

It does not demonstrate that a native QuickJS Edge REPL works.

Still, two relevant ideas were present in the colleague N-API implementation:

1. Register a QuickJS runtime promise hook with `JS_SetPromiseHook(...)`.
2. Preserve and restore `continuation_preserved_embedder_data` around promise
   jobs.

Their QuickJS-NG CMake patch also injected `JS_PROMISE_HOOK_BEFORE` and
`JS_PROMISE_HOOK_AFTER` around `promise_reaction_job()`. Our local QuickJS had
promise hook types and `JS_SetPromiseHook(...)`, but ordinary promise reaction
jobs were not emitting before/after hooks.

## Root cause

Our N-API QuickJS backend stored promise hook callbacks from
`unofficial_napi_set_promise_hooks()`, but it did not register a QuickJS runtime
hook and did not preserve async context frames across promise jobs.

Separately, our local QuickJS did not emit `JS_PROMISE_HOOK_BEFORE` and
`JS_PROMISE_HOOK_AFTER` around normal `promise_reaction_job()` execution. That
means even a registered N-API hook would not see the core `.then` / `await`
continuations that Node's async context and REPL history initialization depend
on.

One extra wrinkle: QuickJS represents async/await continuations with
`JS_CLASS_ASYNC_FUNCTION_RESOLVE` / `JS_CLASS_ASYNC_FUNCTION_REJECT`, not only
with normal promise resolve/reject function objects. A direct copy of the
colleague helper would recover promise identity for normal promise reactions,
but could still miss async-function continuations.

## Why this currently requires a QuickJS source change

For the current vendored QuickJS source, the fix cannot live purely in the
N-API layer. The missing transition happens inside QuickJS's internal
`promise_reaction_job()`. By the time an expression such as:

```js
await hnd.close();
```

resumes, QuickJS is running an engine-owned queued promise job, not calling back
through N-API. If `promise_reaction_job()` does not emit
`JS_PROMISE_HOOK_BEFORE` and `JS_PROMISE_HOOK_AFTER`, the N-API backend has no
reliable point where it can restore and then unwind
`continuation_preserved_embedder_data`.

So there are three realistic paths:

1. Keep the small vendored QuickJS patch. This is what we did, and it is the
   direct fix for our current source tree.
2. Upgrade or switch to a QuickJS/QuickJS-NG version that already emits promise
   hooks around normal reaction jobs. To qualify, its `promise_reaction_job()`
   must call the runtime promise hook before and after invoking the reaction
   handler.
3. Monkey-patch Promise behavior in JS. This is theoretically possible but not
   recommended: it is fragile, changes global Promise behavior, and is likely
   to miss async/await or other internal promise paths.

In short: we do not inherently need a permanent fork of QuickJS, but we do need
an engine that exposes before/after promise reaction hooks. Our current
vendored QuickJS does not, so this repo currently needs the source patch unless
we move to an upstream version with equivalent behavior.

## Fix in our codebase

### QuickJS runtime

File:

```text
~/src/edgejs/quickjs/quickjs.c
```

Added helpers near the promise reaction data definitions:

- `js_promise_function_promise(...)`
- `js_promise_reaction_promise(...)`

The first helper recovers the promise associated with normal QuickJS promise
resolve/reject functions.

The second helper also handles async-function resolve/reject objects by walking
from the async-function resolver back to the async function's public promise.
This is the important difference from the colleague patch for the REPL-history
case, because `await hnd.close()` resumes through the async-function machinery.

Then `promise_reaction_job()` now:

1. Recovers the promise identity from the fulfillment or rejection resolving
   function.
2. Emits `JS_PROMISE_HOOK_BEFORE` before invoking the reaction handler.
3. Emits `JS_PROMISE_HOOK_AFTER` after invoking the reaction handler.

### QuickJS N-API backend

File:

```text
~/src/edgejs/napi/quickjs/src/unofficial_napi.cc
```

Added per-env storage for promise context frames:

```cpp
std::unordered_map<void *, JSValue> promise_context_frames;
std::vector<JSValue> promise_context_frame_stack;
```

Added a QuickJS promise hook implementation:

- On `JS_PROMISE_HOOK_INIT`, capture the current
  `continuation_preserved_embedder_data` for the newly-created promise.
- On `JS_PROMISE_HOOK_BEFORE`, push the current frame and restore the frame
  captured for that promise.
- On `JS_PROMISE_HOOK_AFTER`, restore the previous frame and remove the
  completed promise frame entry.
- Forward registered JS promise hooks (`init`, `before`, `after`, `settled`)
  when they are present.

Registered the hook during env creation:

```cpp
JS_SetPromiseHook(rt, QuickjsPromiseHook, env);
```

Also updated:

- `unofficial_napi_set_promise_hooks(...)` to install the QuickJS hook after
  storing callbacks.
- `unofficial_napi_set_promise_reject_callback(...)` to register
  `JS_SetHostPromiseRejectionTracker(...)`.
- `unofficial_napi_enqueue_microtask(...)` to enqueue a real QuickJS job with
  `JS_EnqueueJob(...)` instead of synthesizing a `Promise.resolve().then(...)`.

## Verification

Rebuilt the QuickJS Edge CLI:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Verified the REPL works with persistent history enabled by pointing `HOME` at a
temporary directory:

```sh
env HOME=/private/tmp/edge-qjs-home ./build-edge-quickjs-cli/edge
```

Inside the REPL:

```text
> 10+32
42
>
```

Verified async context survives promise continuations:

```sh
./build-edge-quickjs-cli/edge --async-context-frame -e \
  "const { AsyncLocalStorage } = require('async_hooks'); const als = new AsyncLocalStorage(); als.run(123, () => Promise.resolve().then(() => console.log('als', als.getStore())));"
```

Observed:

```text
als 123
```

Rebuilt and ran the QuickJS N-API tests:

```sh
env CMAKE_BUILD_TYPE=Debug make build-napi-quickjs
make test-napi-quickjs-only
```

Result:

```text
100% tests passed, 0 tests failed out of 43
```

## Remaining separate issue

Exiting the QuickJS CLI still hits the existing teardown assertion:

```text
Assertion failed: (list_empty(&rt->gc_obj_list)), function JS_FreeRuntime
```

That is separate from the REPL lock. The REPL now becomes ready, resumes after
history initialization, accepts input, and evaluates commands with persistent
history enabled.
