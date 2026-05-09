# Node Test: diagnostics channel async context

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Medium | Tracing channels lose context across promises and a worker-thread diagnostic test hangs. |

Affected tests:

- `parallel/test-diagnostics-channel-tracing-channel-args-types`
- `parallel/test-diagnostics-channel-tracing-channel-promise-run-stores`
- `parallel/test-diagnostics-channel-worker-threads`

## What Is The Issue

The tracing-channel argument validation failure is mostly message parity:
QuickJS reports `TypeError: not an object`, while the test expects a message
matching `Cannot convert undefined or null to object`.

The promise-run-stores test is a behavioral failure. The expected async context
store `{ foo: 'bar' }` is `undefined` after a promise boundary, so the QuickJS
promise/job integration is not preserving the async resource context required by
diagnostics tracing.

The worker-thread diagnostics test times out, which may be a separate missing
worker capability or a hang caused by diagnostics subscriptions crossing worker
startup/shutdown.

## How Should We Fix It

Treat this as two passes:

1. Normalize argument validation in `diagnostics_channel` helpers by explicitly
   checking `null`/`undefined` before calling QuickJS builtins like
   `Object.getPrototypeOf()`.
2. Trace async context propagation through QuickJS promise hooks, microtask
   draining, and `AsyncLocalStorage`. The existing promise hook/microtask work
   should be extended so diagnostics-channel `runStores` sees the active store
   after promise continuations.

For the timeout, rerun the worker test alone with worker/diagnostics traces
after the async-context fix. If it still hangs, create a follow-up worker-thread
issue rather than mixing it into diagnostics-channel store propagation.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-diagnostics-channel-tracing-channel-args-types.js
build-edge-quickjs-cli/edge test/parallel/test-diagnostics-channel-tracing-channel-promise-run-stores.js
build-edge-quickjs-cli/edge test/parallel/test-diagnostics-channel-worker-threads.js
```
