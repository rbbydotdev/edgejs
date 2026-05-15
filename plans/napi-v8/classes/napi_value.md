# `napi_value`

`napi_value` is intentionally not a heap-owned `napi_value__` object in the V8
backend. It is a direct representation of the current V8 local handle slot.

The conversion lives in `napi/v8/src/internal/napi_v8_env.h`:

```cpp
inline napi_value JsValueFromV8LocalValue(v8::Local<v8::Value> local) {
  return reinterpret_cast<napi_value>(*local);
}
```

The reverse conversion reconstructs a `v8::Local<v8::Value>` with the same
memcpy pattern used by Node. This means `napi_value` follows V8 local-handle
lifetime rules. It is valid inside the active handle scope and must not be made
persistent by public value APIs.

Persistence belongs to `napi_ref__`, which stores a `v8::Global<v8::Value>`.
The lifetime tracker can record observed `napi_value` creation by scope for
diagnostics, but that tracking is observational; it does not change the handle
lifetime.

