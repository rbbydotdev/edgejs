# Compatibility Adapter: Native unavailable `inspector` stub

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Makes imports work while the runtime still has no real inspector. |

## Implementation Home

This note tracks compatibility behavior implemented in EdgeJS runtime source under `src/`. The related N-API compatibility adapters from this cleanup effort have been extracted into `napi/quickjs/src/compat` and are documented under `node-compat/napi`.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/next-app/002_standalone_inspector_stub.md`
- `plans/quickjs-wasm/development/dev_001_pr_cleanup_containment/002_native_inspector_fallback.md`

## What Is The Compatibility Adapter

`require("inspector")` and `require("node:inspector")` return a native fallback
object even though `internalBinding("config").hasInspector` and
`process.features.inspector` remain false. Passive APIs no-op; active APIs throw
inspector-unavailable errors.

## Why It Is Suspect

The module is publicly loadable while builtin metadata can still say it cannot
be required. The fallback `Session` is smaller than Node's real object and does
not fully behave like an `EventEmitter`.

## How To Do It Better

Define the contract explicitly: absent inspector, or a documented unavailable
inspector module. If the module is present, make metadata agree with `require()`
and match Node's public shape closely enough for passive consumers, including
`Session` inheritance and stable no-op methods.
