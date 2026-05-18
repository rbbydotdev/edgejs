# `napi_external_wrapper__`

`napi_external_wrapper__` stores the native payload behind a V8
`External`.

It lives in `napi/v8/src/internal/napi_external_wrapper.h` and `.cc`.
`New(...)` allocates the wrapper, creates a `v8::External` whose value points
back to the wrapper, and keeps a weak `v8::Global` to that external. When V8
collects the external, the weak callback deletes the wrapper.

The wrapper stores the raw native data pointer and optional N-API type tag. Type
tags can be set once and later checked by comparing the two 64-bit halves.

Finalization is not owned by this class. If an external has a finalizer, the
public creation path creates a `napi_ref_with_finalizer__` for that behavior.

