# `napi_getter_callback_info__`

`napi_getter_callback_info__` adapts a V8 getter
`PropertyCallbackInfo<v8::Value>` to `napi_callback_info__`.

It lives in `napi/v8/src/internal/napi_getter_callback_info.h` and `.cc`.
Getter callbacks have no JavaScript arguments, so `argc()` returns zero and
`args(...)` fills any requested slots with `undefined`.

The class returns the V8 receiver as `this_arg()`, always returns `nullptr` for
`new_target()`, and returns the accessor payload data from `data()`.

It does not own the property callback info. It is a short-lived adapter for one
getter invocation.

