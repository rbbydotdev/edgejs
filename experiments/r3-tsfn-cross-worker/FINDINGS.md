# R3: threadsafe-function dispatch across worker boundary — empirical

**Date:** 2026-05-23
**Status:** PASS — 50/50 cross-worker tsfn callbacks fired correctly,
in order, with correct payloads, across both blocking and non-blocking
modes.

## Relationship to Q3

`/Users/robertpolana/etc/projects/edgejs/experiments/l5-threadsafe-fn/FINDINGS.md`
resolved Q3 **analytically** by reading emnapi v2 source: `childThread:false`
takes the local-enqueue path, so the cross-worker boundary should be
bridged entirely by the project's SAB-RPC layer. R3 confirms this is
**also true empirically.**

## What was built

`probe.mjs` runs an inverted L5 topology in Node `worker_threads`:
- **main thread** plays "wasm worker" — issues `OP_CALL_TSFN` via SAB-RPC
- **worker thread** plays "host worker" — owns the emnapi context, registers
  the tsfn with a JS callback `(data) => { received.push(data) }`
- 50 cross-worker `napi_call_threadsafe_function` dispatches (25 blocking +
  25 non-blocking), varying payloads

## Mechanism that works

emnapi's tsfn handle is a **uint32 pointer into shared wasm memory** —
meaningful in both workers because the memory is shared. No special
postMessage token needed; the SAB-RPC layer just carries the handle as
a u32.

```js
// Host worker registers the tsfn.
napi.napi_create_threadsafe_function(env, jsFn, ..., &tsfnHandle);
// Hand tsfnHandle (u32) to wasm worker via postMessage or SAB.

// Wasm worker calls it via SAB-RPC:
//   OP_CALL_TSFN, args = [tsfnHandle, dataPtr, mode]
//   → host's emnapi resolves the handle, enqueues callback
//   → setImmediate fires JS callback on host
```

## Production wiring requirements

1. **Register the `tsfn` plugin** when creating napiModule:
   ```js
   import { tsfn } from "@emnapi/core/plugins";
   createNapiModule({ ..., plugins: [tsfn] });
   ```
   Without this, `napi.napi_create_threadsafe_function` is `undefined`.
2. Route all 7 tsfn ops through the SAB-RPC dispatch table — no special
   casing needed:
   - `napi_create_threadsafe_function`
   - `napi_call_threadsafe_function`
   - `napi_acquire_threadsafe_function`
   - `napi_release_threadsafe_function`
   - `napi_ref_threadsafe_function`
   - `napi_unref_threadsafe_function`
   - `napi_get_threadsafe_function_context`
3. `OP_CALL_TSFN` payload: `arg0=handle, arg1=data ptr, arg2=mode`;
   reply: `napi_status`. Standard 3-arg int-return op shape.
4. **No reverse channel needed for tsfn dispatch** — the JS callback runs
   on host where it was registered. The reverse channel is for OTHER
   callback shapes (e.g. `napi_create_function`'s funcref).

## Caveats discovered

- `call_js_cb=0` JS callbacks receive no arguments (emnapi calls
  `jsCallback()`, dropping the data ptr). Real addons pass a non-zero
  `call_js_cb` so this is moot in production; only matters for test
  harnesses.
- Callbacks fire via `setImmediate`, so host worker must yield (already
  does via `Atomics.waitAsync`).
- Blocking vs non-blocking mode only diverges when `max_queue_size>0`
  and queue is full. Backpressure case not validated here — would need
  a separate bounded-queue test.
- No emnapi modification required.

## Status for path (a)

**Risk retired.** tsfn ops are mechanical to add via the existing
`napi-op-handlers.ts` factory pattern. No new infrastructure needed.
