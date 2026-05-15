# `napi_callback_payload__`

`napi_callback_payload__` is the small payload attached to V8 function
callbacks created by N-API.

It lives in `napi/v8/src/internal/napi_callback_payload.h` and stores:

- the `napi_env`;
- the user `napi_callback`;
- the user data pointer.

V8 passes this payload through callback data, and
`napi_function_callback_info__` reads it to find the environment and user data.
The payload does not own V8 handles. It is a bridge between the generated V8
function and the N-API callback trampoline.

