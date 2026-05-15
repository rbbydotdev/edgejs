# `napi_callback_info__`

Status: Current as of 2026-05-15.

`napi_callback_info__` stores one native callback invocation frame.

It lives in `napi/quickjs/src/internal/napi_callback_info.h` and `.cc`. The
record stores the env, `this` value, optional `new.target`, argument count,
argument array, and addon callback data pointer.

Instances are stack-allocated by `napi_function__::trampoline(...)` for the
duration of a JS-to-native call. Public APIs such as `napi_get_cb_info(...)` and
`napi_get_new_target(...)` reinterpret the public `napi_callback_info` back to
this stack record and read from it.

The class does not own QuickJS values. It only references the `JSValueConst`
arguments supplied by QuickJS for the active call. Returned values are wrapped
through the current callback handle scope, not stored in `napi_callback_info__`.
