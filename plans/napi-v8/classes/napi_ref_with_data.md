# `napi_ref_with_data__`

`napi_ref_with_data__` is a `napi_ref__` that also carries a native data
pointer.

It lives in `napi/v8/src/internal/napi_ref_with_data.h` and `.cc`. The class is
used for wrap-style references where an object needs to keep associated native
data available through `napi_unwrap(...)`.

The V8 lifetime behavior is inherited from `napi_ref__`: the value is held in a
`v8::Global`, may become weak at refcount zero, and participates in env ref
tracking. `Data()` returns the stored native pointer.

This class does not run a user finalizer. For finalizer-bearing references, use
`napi_ref_with_finalizer__`.

