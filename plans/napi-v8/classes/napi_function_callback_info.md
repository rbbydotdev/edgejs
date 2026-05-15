# `napi_function_callback_info__`

`napi_function_callback_info__` adapts a live
`v8::FunctionCallbackInfo<v8::Value>` to the abstract
`napi_callback_info__` interface.

It lives in `napi/v8/src/internal/napi_function_callback_info.h` and `.cc`.
It stores references to the V8 callback info and the `napi_callback_payload__`.
When N-API asks for arguments, it copies V8 arguments into the caller-provided
`napi_value` array as direct local handles. Missing arguments are filled with
V8 `undefined`.

`this_arg()` returns `info.This()`. `new_target()` returns `info.NewTarget()`
only for construct calls, matching N-API constructor semantics. `data()` returns
the user data pointer from the payload.

This class is intentionally non-owning. It is valid only for the active
callback invocation.

