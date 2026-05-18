# `napi_external_backing_store_hint__`

`napi_external_backing_store_hint__` stores finalization metadata associated
with external backing stores.

It is currently defined in
`napi/v8/src/internal/napi_env_records.h`. The struct holds the env, external
data pointer, optional finalizer callback, and finalizer hint.

The object is small bookkeeping around V8 backing-store lifetime. Its parent is
the V8 backing store, not `napi_env__`, because V8 can release backing stores
after env teardown while disposing an isolate. Creation/release are still
reported to the lifetime tracker manually, but deletion belongs to the V8
backing-store deleter.

`napi_env__` keeps a registry of outstanding hints. If env teardown happens
first, it runs any pending finalizers, records the lifetime release, clears the
hint's env pointer, and leaves the shell for the later V8 deleter to delete.
