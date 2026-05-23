# Q3: threadsafe function dispatch — findings (analytical)

**Date:** 2026-05-23
**Result:** RESOLVED by analysis — no probe needed; emnapi v2's existing
mechanism just works in the L5 split-worker topology.

## The question

When wasm calls `napi_call_threadsafe_function(handle, data, mode)`,
this needs to eventually invoke a JS callback on the JS-owning
thread.  In OUR L5 split-worker topology, JS lives on host worker.

Does emnapi v2's tsfn mechanism work cross-worker?

## Analysis of emnapi v2 source

### How emnapi normally dispatches tsfn

`vendor/emnapi/packages/emnapi/src/threadsafe-function.ts:810`:

```js
if (ENVIRONMENT_IS_PTHREAD) {
  // Worker threads only post a wakeup token. Main-thread draining is
  // serialized by enqueue() once the message is received.
  postMessage({
    __emnapi__: {
      type: 'tsfn-send',
      payload: { tsfn: func }
    }
  })
} else {
  // Local enqueue + setImmediate dispatch
  this.enqueue(func)
}
```

emnapi splits behavior based on `ENVIRONMENT_IS_PTHREAD`:
- pthread mode: postMessage to main thread; main drains the queue
- main mode: locally enqueue; setImmediate dispatches

### How this maps to L5

In our split-worker topology:
- We create napiModule on HOST with `childThread: false`
- `ENVIRONMENT_IS_PTHREAD = Boolean(options.childThread) = false`
- emnapi thinks it IS the main thread (because in our split, the JS context IS on host; there's no separate "main" to postMessage to)

When wasm worker calls `napi_call_threadsafe_function` via our SAB-RPC:
1. RPC arrives at host's RPC server.
2. Host calls `hostNapi.napi_call_threadsafe_function(handle, data, mode)`.
3. Inside this function, emnapi's logic: `ENVIRONMENT_IS_PTHREAD === false`, so LOCAL ENQUEUE.
4. The data is added to the tsfn queue (in-memory JS data structure).
5. emnapi schedules a setImmediate to drain the queue.
6. setImmediate fires; emnapi calls the registered JS callback with the data.
7. JS callback runs on host (the right place — that's where it was registered).

**No cross-worker postMessage needed.**  emnapi's "main-mode" path is
exactly what we want.

## Wait — what about the data parameter?

`napi_call_threadsafe_function(handle, data, mode)`: `data` is a
wasm-side pointer that the JS callback will read.  emnapi reads bytes
from `wasmMemory.buffer` at that pointer when dispatching.

In split-worker: wasm memory is shared.  Host can read at the pointer
directly.  Same as for napi_create_string_utf8 etc.

## Conclusion

**Q3 resolves with no extra work.**  Pattern:

1. Create napiModule on host with `childThread: false`.
2. RPC-route `napi_create_threadsafe_function`, `napi_call_threadsafe_function`,
   etc. to host (same as other napi ops).
3. emnapi's main-mode dispatch handles the rest.

The `postMessage` hook + pthread mode is a SEPARATE feature for
emnapi's own pthread-pool model where wasm has multiple internal
threads.  We don't use that mode; we use our own L4 reverse channel
for any host-to-wasm callbacks (finalizers, etc.).

## What might still bite

- **Promise rejection callback** (`napi_set_promise_reject_callback`):
  similar pattern — registered on host, called locally.  Should
  just work.
- **Async work** (`napi_create_async_work` / `napi_queue_async_work`):
  emnapi's async-work pool needs configuration.  With `asyncWorkPoolSize: 0`,
  it runs synchronously on the JS thread.  For real async work, need
  `onCreateWorker` callback.  TBD if needed for L5 F-1.

## No probe code

The architecture is structural; no new code is needed to validate
beyond what's already in `experiments/l5-real-roundtrip/probe.mjs`
(which uses napiModule with `childThread: false`).

When we get to F-1 implementation, tsfn ops route through the same
RPC as other napi ops — no special-casing.
