# `napi_scope__`

Status: Current as of 2026-05-15.

`napi_scope__` is the QuickJS handle-scope record.

It lives in `napi/quickjs/src/internal/napi_scope.h` and `.cc`. Each scope stores
its owning env, lexical scope level, parent handle, an allocator of
`napi_value__` slots, and lifecycle flags for closed/escaped state.

QuickJS does not provide V8-style local handle blocks, so `napi_scope__` is the
backend's local-value owner. `wrap_value(...)` allocates a `napi_value__` in the
scope's `values_` allocator. Closing the scope closes that allocator, which
destroys every active `napi_value__` and frees the wrapped QuickJS values.

Escapable scopes are represented by the same internal type. `escape_value(...)`
checks that the value is owned by this scope, duplicates the underlying
`JSValueConst` into the parent scope with `owned=false`, and records the escape
for diagnostics. `mark_escaped()` prevents public escapable-scope APIs from
escaping more than once.

Scopes are themselves env-owned allocator payloads. Public `napi_handle_scope`
handles are typed pointers to `napi_scope__` slots, and `napi_env__` is
responsible for translating public scope handles back to internal scope records.
