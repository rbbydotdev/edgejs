# `napi_callback_info__`

`napi_callback_info__` is the abstract view that N-API callbacks use to inspect
their call frame. It replaces the old design where callback info owned copied
`napi_value` wrappers.

The interface is in `napi/v8/src/internal/napi_v8_env.h`. It exposes:

- `argc()`
- `args(...)`
- `this_arg()`
- `new_target()`
- `data()`

The concrete subclasses adapt live V8 callback data into this interface:
`napi_function_callback_info__`, `napi_getter_callback_info__`, and
`napi_setter_callback_info__`.

The design keeps callback values current-scope locals. Arguments, `this`, and
`new.target` are wrapped through `napi_v8_wrap_value(...)` when requested, not
stored as persistent state.

