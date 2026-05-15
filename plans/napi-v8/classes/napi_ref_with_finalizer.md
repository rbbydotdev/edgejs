# `napi_ref_with_finalizer__`

`napi_ref_with_finalizer__` is a `napi_ref__` that carries native data plus a
finalizer callback and hint.

It lives in `napi/v8/src/internal/napi_ref_with_finalizer.h` and `.cc`. It is
used by APIs such as `napi_create_external(...)`, `napi_wrap(...)`, and
`napi_add_finalizer(...)` when N-API must call user cleanup code after the JS
object becomes collectible or the env is torn down.

Instances link into `env->finalizing_reflist`, not the ordinary ref list. When
V8 reports GC finalization, the class asks `napi_env__` to enqueue finalization
so user callbacks run from the env's microtask-drained finalizer queue.

`CallUserFinalizer()` snapshots and clears the finalizer fields before invoking
the callback. That avoids repeated calls if the finalizer path is reentered or
the object is later destroyed.

