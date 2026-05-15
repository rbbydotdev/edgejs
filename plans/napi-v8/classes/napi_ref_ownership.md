# `napi_ref_ownership__`

`napi_ref_ownership__` records who is responsible for deleting a `napi_ref__`.

It lives in `napi/v8/src/internal/napi_ref.h` and currently has two values:

- `kRuntime`
- `kUserland`

Runtime-owned refs are created for internal bookkeeping such as finalizer refs
that should delete themselves after the runtime invokes their finalizer.
Userland-owned refs are returned to N-API callers and are deleted through the
public reference deletion API.

This distinction keeps Node-style finalizer behavior without turning every
reference into public caller-owned storage.

