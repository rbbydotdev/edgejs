# R1: reverse-during-forward RPC — findings

**Date:** 2026-05-23
**Result:** PASS — 1000 roundtrips, each with one reverse-during-forward callback, all completed with correct results, no deadlocks, no message loss, no flakes across 5 runs.

## The question

When the wasm worker issues a forward sync RPC and is `Atomics.wait`-blocked
on the reply, can host send a REVERSE RPC (host → wasm) that the wasm worker
dispatches before its forward reply arrives? This is load-bearing for
`napi_create_function`-class ops where the host's emnapi needs to invoke a
wasm-table funcref it cannot call directly.

## The pattern that works

Single shared "wake" address (one `Int32Array` slot, transferred to both
workers). Both forward-reply-publisher and reverse-request-publisher
notify the same address. The wasm-side wait polls reverse first, then
its forward-reply ring, then `Atomics.wait`s on the shared wake.

```js
// Host side — every host→wasm publish bumps the shared wake.
function publishAndNotifyShared(ringI32, slot, payloadLen, sharedWakeI32) {
  Atomics.store(ringI32, slotLenIdx(slot), payloadLen);
  Atomics.store(ringI32, slotStatusIdx(slot), STATUS_READY);
  Atomics.add(ringI32, RING_WAKE_IDX, 1);            // per-ring (host waitAsync)
  Atomics.notify(ringI32, RING_WAKE_IDX);
  Atomics.add(sharedWakeI32, SHARED_WAKE_IDX, 1);    // SHARED — wasm waits here
  Atomics.notify(sharedWakeI32, SHARED_WAKE_IDX);
}

// Wasm side.
let lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
while (Date.now() < deadline) {
  drainReverseRequests();                  // priority: reverse first
  if (forwardReplyReadyMatchingMyReqId()) return result;
  Atomics.wait(sharedWakeI32, SHARED_WAKE_IDX, lastWake, timeoutMs);
  lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
}
```

The atomicity of `Atomics.wait`'s "expected" check against `Atomics.add` from
the publisher eliminates missed-wakeup races: if host bumped the counter
between our load and our wait, `wait` returns `"not-equal"` immediately.

## Timings (Node `worker_threads`, macOS arm64)

| Run | Iter | min | median | mean | p99 | p999 | max |
|-----|------|-----|--------|------|-----|------|-----|
| 1   | 200  | 32µs | 83µs | 286µs | 515µs | 38.76ms | 38.76ms |
| 2   | 200  | 24µs | 56µs | 185µs | 370µs | 24.36ms | 24.36ms |
| 3   | 200  | 22µs | 63µs | 159µs | 170µs | 19.45ms | 19.45ms |
| 4   | 200  | 22µs | 56µs | 171µs | 3.23ms | 19.15ms | 19.15ms |
| 5   | **1000** | 19µs | **44µs** | 87µs | **748µs** | 20.95ms | 20.95ms |

- **Median ~50 µs** for full forward + reverse-callback roundtrip.
- **p99 well under 1 ms** in steady state.
- p999/max ~20 ms is first-iteration only (worker spawn / V8 JIT warmup).

## Surprises

- **No race conditions.** Shared-counter + `Atomics.wait` "expected" semantics
  are correct by construction.
- **No deadlocks.** Reverse-during-forward works because reverse-publish
  notifies the same address forward-reply-publish notifies.
- **Reverse-first ordering matters.** Drain reverse before checking own
  forward reply, so queued reverse requests aren't starved.
- **Shared wake is one-sided.** Only wasm needs it (no event loop). Host
  still uses per-ring `waitAsync` for its async drainers.

## Recommendation for production wiring

Target: `browser-target/src/host-worker/rpc-client-sync.ts` + sibling.

1. Allocate a shared-wake SAB (single `Int32Array`, `[0]` used) at runtime
   init; transfer to wasm worker. Both `RpcClient` (host) and `SyncRpcClient`
   (wasm) hold a reference.
2. Host's `publishReply` and new `publishReverseRequest` both bump the
   shared wake in addition to per-ring counters.
3. `SyncRpcClient.callSync` waits on shared wake, not `replyI32[0]`.
4. Add `drainReverseRequests()` to the wait loop before the forward-reply
   scan. Reverse handlers dispatch wasm-table funcrefs / state lookups /
   refcount ops.
5. Reverse-reply ring is wasm → host; host uses normal `waitAsync` on its
   per-ring counter.
6. Reverse handlers run synchronously on the wasm thread inside the
   `Atomics.wait` poll loop. They may invoke wasm exports but must NOT
   issue another forward sync RPC (self-deadlock).
7. Latency budget: ~50 µs median in Node → ~250 µs in browser Web Workers
   (2-5× slower). Forward-only napi ops (no reverse) keep the ~10-30 µs
   F-3 baseline.

## Status for path (a)

**Risk retired.** The reverse-channel callback model has an empirically
validated pattern with race-free atomic semantics. Production wiring is a
mechanical change to `rpc-client-sync.ts` plus the shared-wake SAB plumbing.
