# `napi_handle_scope_wrapper__`

`napi_handle_scope_wrapper__` is the small RAII wrapper around
`v8::HandleScope`.

It lives in `napi/v8/src/internal/napi_handle_scope_wrapper.h` and `.cc`.
The constructor receives the isolate and constructs a V8 handle scope. The
wrapper is embedded inside `napi_handle_scope__`.

This class exists because the public opaque N-API struct is defined in the main
implementation file, while the V8-specific scope object is easier to keep in a
small internal helper. It has no policy beyond RAII ownership of the V8
`HandleScope`.

