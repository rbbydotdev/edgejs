# `napi_escapable_handle_scope_wrapper__`

`napi_escapable_handle_scope_wrapper__` is the RAII wrapper around
`v8::EscapableHandleScope`.

It lives in `napi/v8/src/internal/napi_escapable_handle_scope_wrapper.h` and
`.cc`. It is embedded inside `napi_escapable_handle_scope__`.

The wrapper exposes `Escape(...)`, which forwards to V8 and marks
`escape_called_`. N-API uses that state to enforce the one-escape rule.

The class keeps V8's semantics intact: escaping moves one local handle into the
parent handle scope; it does not make the value persistent.

