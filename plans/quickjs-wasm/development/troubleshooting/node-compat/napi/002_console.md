# N-API Compat: Console

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/console.{h,cc}`. |
| **Severity** | Medium | Incorrect console bindings break diagnostics, tests, and bootstrap visibility. |

## Source Pair

- `napi/quickjs/src/compat/console.h`
- `napi/quickjs/src/compat/console.cc`

## What It Does

The console adapter provides `RepairBootstrapConsoleBindings(...)`. It runs during QuickJS N-API environment creation and ensures the global `console` methods are bound to the runtime console implementation rather than left as stale or partially initialized bootstrap functions. The implementation lives with the N-API compatibility adapters even though it was originally carried in the Edge runtime source.

## Why It Is Needed

Node programs expect `console.log`, `console.error`, and related methods to work early in process startup and from native-backed contexts. During the QuickJS bootstrap, the global object and the CommonJS-visible console module can be assembled in a different order from Node/V8. Without this adapter, logging can appear present while being disconnected from the actual stdout/stderr-backed console implementation.

## Could We Do It Better

The best long-term fix is to make the JavaScript bootstrap create the final console object in the correct order, with methods bound once and no post-bootstrap repair pass. The C++ adapter is a useful containment point today, but it should eventually shrink to a bootstrap assertion or disappear once console initialization is owned by the Node-compatible runtime layer.
