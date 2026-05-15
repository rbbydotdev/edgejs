# `quickjs::detail::napi_callsite__`

Status: Current as of 2026-05-15.

`napi_callsite__` adapts QuickJS stack-frame data to V8-shaped callsite helper
APIs.

It lives in `napi/quickjs/src/internal/napi_callsite.h` and `.cc` under the
`quickjs::detail` namespace. The class is static-only.

`get_call_sites(...)` and `get_current_stack_trace(...)` call
`JS_GetCurrentStackTrace(...)` with different skip counts and wrap the resulting
QuickJS array into the current N-API scope. The implementation caps frame count
to a small fixed maximum to avoid accidental unbounded stack capture.

`get_caller_location(...)` captures one caller frame, extracts line, column, and
script name/source URL when available, and returns a three-element JavaScript
array. Missing or incomplete stack data is reported as a successful `nullptr`
result rather than throwing.
