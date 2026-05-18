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

## 2026-05-15 Update

The `parallel/test-diagnostics-channel-tracing-channel-args-types` message
failure is fixed in the vendored QuickJS source. `Object.getPrototypeOf()` and
`Reflect.getPrototypeOf()` now throw `TypeError: Cannot convert undefined or
null to object` for `null`/`undefined`, matching the V8/Node text that
`Channel[Symbol.hasInstance]` exposes during diagnostics-channel validation.

Targeted verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
build-edge-quickjs-cli/edge test/parallel/test-diagnostics-channel-tracing-channel-args-types.js
```

The broader async-context and worker-thread diagnostics failures remain tracked
by this note.

## How Should We Fix It

Treat this as two passes:

1. Keep the argument-validation message parity in vendored QuickJS, where
   `Object.getPrototypeOf()` and `Reflect.getPrototypeOf()` produce their
   observable TypeError text.
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
