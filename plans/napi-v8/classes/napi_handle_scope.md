# `napi_handle_scope__`

`napi_handle_scope__` is the public opaque N-API handle-scope object.

It is currently defined in `napi/v8/src/js_native_api_v8.cc`. The struct stores
the env and a `napi_handle_scope_wrapper__`, which owns the actual
`v8::HandleScope`.

The important design point is that this is a real V8 handle scope, not an Edge
side vector of persistent value wrappers. Opening a N-API handle scope opens V8
local-handle storage; closing it releases the locals created inside that scope
according to V8 rules.

The constructor and destructor report scope allocation and release to the V8
lifetime tracker when tracking is enabled.

