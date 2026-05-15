# `napi_external__`

Status: Current as of 2026-05-15.

`napi_external__` is the QuickJS external class and helper surface for native
opaque payloads.

It lives in `napi/quickjs/src/internal/napi_external.h` and `.cc`. The class
registers one QuickJS class ID named `NapiExternal`; external values store a
`napi_external_backing_store_hint__` as their opaque pointer. `get_value(...)`
returns the hint's native data pointer.

The same helper owns object-wrap metadata conventions. Wrapped objects can carry
an external record either as the object's own opaque value or through the
`__napi_wrap__` property. Type tags, buffer markers, and finalizer metadata are
stored under internal property names so public N-API code does not need to know
QuickJS class details.

For Buffer-like objects, `mark_buffer(...)`, `is_buffer(...)`, and
`get_buffer_info(...)` use a marker property plus QuickJS typed-array APIs to
recover backing data and byte length.

Finalization is delegated to `napi_external_backing_store_hint__`. The QuickJS
class finalizer invokes the N-API finalizer once and then asks the env-owned
hint allocator to destroy the hint. External ArrayBuffer deleters use the same
hint path, with a detach guard so the finalizer is not run twice during explicit
detach flows.
