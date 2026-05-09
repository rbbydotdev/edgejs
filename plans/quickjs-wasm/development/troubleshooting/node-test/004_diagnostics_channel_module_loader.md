# Node Test: diagnostics channel module loader events

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Medium | Diagnostics are missing for ESM module loading, which hides loader lifecycle events from observers. |

Affected tests:

- `parallel/test-diagnostics-channel-module-import`
- `parallel/test-diagnostics-channel-module-import-error`

## What Is The Issue

Both tests subscribe to module import diagnostics and receive an empty event
array. The failure cases expect `start`, `end`, `error`, `asyncStart`, and
`asyncEnd` records, including the requested URL and parent module URL.

The QuickJS ESM loader currently reports module resolution/evaluation errors to
the caller, but it does not publish Node's diagnostics-channel lifecycle events
around the import.

## How Should We Fix It

Find the QuickJS ESM load/translate/evaluate path and add the same JS-side
diagnostic publications that Node's loader emits. The event payload must include
at least:

- `url`
- `parentURL`
- `name`
- `error` for failed imports

Make sure failed resolution publishes both synchronous and async diagnostic
events before rejecting the import promise. The fix should live near the module
loader bridge, not inside `diagnostics_channel` itself, because normal pub/sub
tests already pass in this run.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-diagnostics-channel-module-import.js
build-edge-quickjs-cli/edge test/parallel/test-diagnostics-channel-module-import-error.js
```
