# `napi_ref__`

`napi_ref__` is the persistent N-API reference object for the V8 backend.

It lives in `napi/v8/src/internal/napi_ref.h` and `.cc`. Unlike `napi_value`,
which is only a current-scope local handle, `napi_ref__` owns a
`v8::Global<v8::Value>`. This is the correct place for persistence.

The ref stores an env pointer, a V8 global, a refcount, ownership mode, and a
flag saying whether the target can be weak. Objects and symbols can be held
weakly. If the initial refcount is zero, the constructor immediately makes the
global weak. `Ref()` promotes a weak ref back to strong by clearing weakness;
`Unref()` makes it weak again when the count reaches zero.

Weak callbacks reset the V8 global and invoke finalization. Runtime-owned refs
delete themselves after finalization; userland refs are deleted by explicit
N-API delete paths.

Refs are allocated from `napi_env__` with the shared allocator. Allocation and
release report to the lifetime tracker through
`napi_allocator_lifetime__<napi_ref__, napi_env__>`. With tracking disabled,
that hook is a no-op.
