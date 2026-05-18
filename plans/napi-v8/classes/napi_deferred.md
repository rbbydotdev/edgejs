# `napi_deferred__`

`napi_deferred__` is the N-API promise resolver record.

It is currently defined in `napi/v8/src/js_native_api_v8.cc`. It stores the env
and a persistent `v8::Global<v8::Promise::Resolver>`.

`napi_create_promise(...)` allocates this record and returns the promise as a
current-scope `napi_value`. Later, `napi_resolve_deferred(...)` or
`napi_reject_deferred(...)` retrieves the resolver from the global, resolves or
rejects it in the env context, and releases the record.

This is a correct persistent use of V8: the promise result is a local
`napi_value`, while the deferred resolver that must survive beyond the current
scope is held by a V8 global.

