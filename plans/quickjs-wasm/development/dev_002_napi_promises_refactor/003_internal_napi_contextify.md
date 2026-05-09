# Internal N-API Contextify Refactor

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Contextify helpers live in `napi_contextify__`; native QuickJS tests pass. |
| **Severity** | Medium | Contextify diagnostics affect script compilation and source-map reporting. |

## Scope

Contextify state lives in:

```text
napi/quickjs/src/internal/napi_contextify.h
napi/quickjs/src/internal/napi_contextify.cc
```

`napi_contextify__` wraps contextify helpers/state, and `napi_env__` owns an
instance directly.

## Known Limitation

These V8-shaped APIs remain limited for QuickJS:

```text
unofficial_napi_preserve_error_source_message
unofficial_napi_set_source_maps_enabled
unofficial_napi_set_get_source_map_error_source_callback
```

The reason is documented near the implementation and tests.

## Current State

- Added `napi/quickjs/src/internal/napi_contextify.{h,cc}` with class
  `napi_contextify__`.
- Moved contextify make/run/dispose/compile/cache-data/module-syntax handling,
  compile exception annotation, source-map toggles, and caught-error formatting
  fallbacks behind the class.
- `napi_env__` owns a direct `quickjs::detail::napi_contextify__` member and
  exposes `contextify()` accessors.
- `napi/quickjs/src/unofficial_napi.cc` now delegates the contextify and
  source-map/error-formatting unofficial APIs through `env->contextify()`.
- `napi/quickjs/CMakeLists.txt` builds `src/internal/napi_contextify.cc`.
The source-map APIs remain intentionally limited for QuickJS. The class stores
the enabled flag and validates/stores the optional callback, but
`preserve_error_source_message()` remains a stable no-op because QuickJS does
not expose a V8-style message object for arbitrary caught `Error` values.

## Verification

Run from `/Users/sadhbh/src/dev/edgejs/napi`:

```sh
make test-native-quickjs
```

Result on 2026-05-09:

```text
100% tests passed, 0 tests failed out of 45
```
