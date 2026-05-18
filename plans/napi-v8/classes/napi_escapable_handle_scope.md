# `napi_escapable_handle_scope__`

`napi_escapable_handle_scope__` is the public opaque N-API escapable
handle-scope object.

It is currently defined in `napi/v8/src/js_native_api_v8.cc`. The struct stores
the env and a `napi_escapable_handle_scope_wrapper__`, which owns the real
`v8::EscapableHandleScope`.

An escapable scope lets one local handle leave the inner scope and become valid
in the parent scope. The wrapper tracks whether `Escape(...)` has already been
called, preserving the N-API rule that only one value may escape.

Like normal handle scopes, it exists to expose V8's existing local-scope
behavior rather than to emulate persistence.

