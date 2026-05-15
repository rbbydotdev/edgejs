# `napi_value__`

Status: Current as of 2026-05-15.

`napi_value__` is the QuickJS-backed local N-API value slot.

It lives in `napi/quickjs/src/internal/napi_value.h` and `.cc`. The struct stores
the owning env and one `JSValue`. If constructed with `owned=true`, it takes the
incoming `JSValue` as-is. If constructed with `owned=false`, it duplicates the
incoming value with `JS_DupValue(...)`.

The destructor frees the stored `JSValue` with `JS_FreeValue(...)` while the env
and context are still valid. This makes `napi_value__` the central RAII wrapper
for QuickJS values exposed through public N-API handles.

Unlike the V8 backend, `napi_value` is not a direct engine local handle. It is a
pointer to a `napi_value__` payload owned by the current `napi_scope__`. Public
N-API code reaches the underlying QuickJS value through
`napi_quickjs_value_inner(...)`, which validates the env/scope relationship in
debug builds and returns `JSValueConst`.

Persistence belongs to `napi_ref__`, not `napi_value__`. A value slot should be
treated as local to its owning handle scope.
