# `napi_accessor_payload__`

`napi_accessor_payload__` is the payload attached to V8 property accessors
created from N-API property descriptors.

It lives in `napi/v8/src/internal/napi_callback_payload.h` and stores the env,
getter callback, setter callback, and user data pointer. Getter and setter V8
trampolines use it to construct either `napi_getter_callback_info__` or
`napi_setter_callback_info__`.

Like `napi_callback_payload__`, this struct is not a handle owner. It is
callback metadata. V8 owns the callback path, and N-API uses this payload to
recover the user callback and data.

