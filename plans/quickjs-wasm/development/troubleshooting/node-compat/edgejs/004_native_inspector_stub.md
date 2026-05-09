# Known Issue: Native unavailable `inspector` stub

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Native unavailable-inspector module exists with known shape limits. |
| **Severity** | Medium | Makes imports work while the runtime still has no real inspector. |

## Current State

This issue belongs to EdgeJS runtime/bootstrap code, not QuickJS N-API.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/next-app/002_standalone_inspector_stub.md`
- `plans/quickjs-wasm/development/dev_001_pr_cleanup_containment/002_native_inspector_fallback.md`

## Known Incompatibility

`require("inspector")` and `require("node:inspector")` return a native fallback
object even though `internalBinding("config").hasInspector` and
`process.features.inspector` remain false. Passive APIs no-op; active APIs throw
inspector-unavailable errors.

## Risk

The module is publicly loadable while builtin metadata can still say it cannot
be required. The fallback `Session` is smaller than Node's real object and does
not fully behave like an `EventEmitter`.

## Current Status

Define the contract explicitly: absent inspector, or a documented unavailable
inspector module. If the module is present, make metadata agree with `require()`
and match Node's public shape closely enough for passive consumers, including
`Session` inheritance and stable no-op methods.
