# `napi_setter_callback_info__`

`napi_setter_callback_info__` adapts a V8 setter
`PropertyCallbackInfo<void>` plus the assigned value to `napi_callback_info__`.

It lives in `napi/v8/src/internal/napi_setter_callback_info.h` and `.cc`.
Setter callbacks expose one N-API argument: the value being assigned. If the
caller asks for more argument slots, the remaining entries are filled with
`undefined`.

The class returns the V8 receiver as `this_arg()`, always returns `nullptr` for
`new_target()`, and returns the accessor payload data from `data()`.

The stored `v8::Local<v8::Value>` is still only a local handle. This class does
not extend its lifetime beyond the active setter call.

