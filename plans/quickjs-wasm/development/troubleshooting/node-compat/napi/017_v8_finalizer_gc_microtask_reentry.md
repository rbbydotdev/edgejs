# V8 finalizer GC microtask reentry

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed by moving GC weak-callback finalizer drains onto the embedder foreground-task queue. |
| **Severity** | High | V8 backend can abort under HTTP load when a weak callback schedules a microtask during GC. |

## Failure

Running the V8-backed Edge CLI in `~/Development/stackmachine.com`:

```sh
/Users/syrusakbary/Development/edgejs/build-edge/edge pnpm run start
ab -n 1000 -c 10 http://localhost:4321/
```

can abort inside V8:

```text
Check failed: v8_flags.separate_gc_phases && young_gc_while_full_gc_ implies current_.state == Event::State::SWEEPING.
...
v8::internal::MicrotaskQueue::EnqueueMicrotask(...)
napi_env__::InvokeFinalizerFromGC(napi_ref_tracker__*)
v8::internal::GlobalHandles::InvokeFirstPassWeakCallbacks()
```

## Diagnosis

The weak reference path correctly avoids running the user finalizer directly
inside V8's weak callback. However, `napi_env__::EnqueueFinalizer(...)` still
calls `isolate->EnqueueMicrotask(...)` from that weak callback.

That call allocates V8 objects while V8 is already running GC weak callbacks.
Under load, the allocation can trigger a nested young GC while the outer full GC
is not in the sweeping state V8 expects, causing the fatal check.

The same weak-callback shape also existed for native buffer records:
`BufferWeakCallback(...)` removed the record from `buffer_records`, reset its
weak holder, then called `isolate->EnqueueMicrotask(...)` to run the buffer
finalizer. That path did not appear in the reported stack, but it had the same
V8-GC reentry hazard.

## Fix

The V8 backend now treats GC weak callbacks as V8-heap allocation-free handoff
points:

1. `napi_env__::InvokeFinalizerFromGC(...)` queues the `napi_ref_tracker__` in
   `pending_finalizers`.
2. `BufferWeakCallback(...)` queues the detached `napi_buffer_record__` in
   `pending_buffer_finalizers`.
3. Both queues schedule a single drain through Edge's embedder foreground-task
   hook when present.
4. Explicit microtask checkpoints also drain the finalizer queue so standalone
   tests and embedders without the foreground-task hook still observe
   finalizers.

## Verification

Built both the root V8 Edge CLI and the standalone V8 N-API test tree:

```sh
cmake --build build-edge --target edge -j8
make -C napi build-napi BUILD_NAPI_DIR=/Users/syrusakbary/Development/edgejs/build-napi-v8-standalone
```

Targeted tests passed:

```sh
/Users/syrusakbary/Development/edgejs/build-napi-v8-standalone/v8/tests/napi_v8_test_38_finalizer
/Users/syrusakbary/Development/edgejs/build-napi-v8-standalone/v8/tests/napi_v8_test_21_general
```

The V8 N-API suite passes when excluding the known contextify test that asserts
QuickJS-specific global marker behavior:

```sh
ctest --test-dir /Users/syrusakbary/Development/edgejs/build-napi-v8-standalone \
  --output-on-failure -R '^napi_v8\.' \
  -E 'SandboxGlobalThisAndMarkerAreNotEnumerableForDeepFreeze'
```

The full V8 N-API suite still has that unrelated failure:

```text
napi_v8.napi_v8_test_65_unofficial_contextify.Test65UnofficialContextify.SandboxGlobalThisAndMarkerAreNotEnumerableForDeepFreeze
```

The original load reproduction now completes and the server remains alive:

```sh
cd /Users/syrusakbary/Development/stackmachine.com
/Users/syrusakbary/Development/edgejs/build-edge/edge pnpm run start
ab -n 1000 -c 10 http://localhost:4321/
curl -I --max-time 5 http://localhost:4321/
```

`ab` completed all 1000 requests, and the follow-up `curl -I` returned
`HTTP/1.1 200 OK`.
