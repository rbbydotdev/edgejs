# `napi_deferred__`

Status: Current as of 2026-05-15.

`napi_deferred__` is the QuickJS N-API promise resolver record.

It lives in `napi/quickjs/src/internal/napi_deferred.h` and `.cc`. The record
stores the env plus the QuickJS resolve and reject functions returned by promise
creation.

`napi_create_promise(...)` creates a promise and stores its resolving functions
in an env-owned deferred slot. Later, `napi_resolve_deferred(...)` or
`napi_reject_deferred(...)` calls the stored function with the supplied
resolution/rejection value and then destroys the deferred record.

The destructor frees both stored QuickJS functions. That makes the deferred
record the persistent owner of the resolver pair, while the promise returned to
JavaScript remains an ordinary scoped `napi_value`.
