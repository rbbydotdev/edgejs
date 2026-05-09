# Known Issue: Property setting semantics

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented as focused QuickJS N-API internal property-setting logic. |
| **Severity** | Medium | Property assignment differences can surface as surprising N-API behavior. |

## Current State

Property setting logic lives in:

- `napi/quickjs/src/internal/napi_set_property.h`
- `napi/quickjs/src/internal/napi_set_property.cc`

`js_native_api_quickjs.cc` delegates through this focused internal helper rather
than carrying local property semantics.

## Known Incompatibility

N-API callers expect property operations to follow Node/V8 behavior, not raw
QuickJS descriptor semantics in every edge case. Libraries that attach state to
objects during initialization can trip over inherited readonly or accessor-only
properties if the backend simply forwards to QuickJS.

## Current Status

Keep public N-API property setters routed through this tested property semantics
layer. The layer should document when QuickJS behavior is preserved and when
Node/V8 observable behavior is intentionally matched.
