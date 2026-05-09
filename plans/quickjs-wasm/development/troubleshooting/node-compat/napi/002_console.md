# Known Issue: Console bootstrap binding

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | N-API console repair was removed; remaining work belongs in EdgeJS bootstrap if needed. |
| **Severity** | Medium | Incorrect console bindings break diagnostics, tests, and bootstrap visibility. |

## Current State

`RepairBootstrapConsoleBindings(...)` is no longer part of QuickJS N-API
startup. QuickJS N-API environment creation should not patch the EdgeJS console
object after bootstrap.

## Known Incompatibility

Node programs expect `console.log`, `console.error`, and related methods to work
early in process startup and from native-backed contexts. If EdgeJS bootstrap
assembles the global object and CommonJS-visible console module in the wrong
order, logging can appear present while being disconnected from the actual
stdout/stderr-backed console implementation.

## Current Status

If this regresses, fix EdgeJS JavaScript bootstrap so it creates the final
console object in the correct order, with methods bound once. A bootstrap
assertion is fine; a late N-API repair pass should not return.
