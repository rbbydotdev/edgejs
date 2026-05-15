# `napi_lifetime__`

`napi_lifetime__<T>` is the generic adapter that lets V8 N-API classes report
create and release events to `napi_lifetime_tracker__`.

It lives in `napi/v8/src/internal/napi_lifetime_tracker.h` under
`v8impl::detail`. For a tracked type, `record_create(owner, value)` and
`record_release(owner, value)` call the raw tracker with a stable type name.

The helper is intentionally thin. It keeps call sites uniform:

```cpp
v8impl::detail::napi_lifetime__<napi_ref__>::record_create(env, this);
```

With lifetime tracking disabled, the underlying tracker methods are no-ops, so
the same call site compiles in default builds.

