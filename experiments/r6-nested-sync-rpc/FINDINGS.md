# R6a: nested sync RPC during reverse callback — findings

**Date:** 2026-05-23
**Result:** PASS — re-entrant nested sync RPC works at all tested depths
(up to 16 levels deep) with no deadlock, no slot exhaustion, no flakes.

## The question

R1 validated that wasm worker blocked in `Atomics.wait` for a forward RPC
reply can drain reverse-channel requests via a single-shared-wake pattern.
But R1 explicitly punted (`r1-reverse-during-forward/FINDINGS.md:86-88`):
"Reverse handlers... must NOT issue another forward sync RPC (self-deadlock)."

That punt is unlivable in production: real napi callbacks routinely make
their own napi calls (e.g., `napi_get_value_int32` to inspect args).
R6a asks: can `SyncRpcClient.callSync` be re-entered safely from inside
a reverse-channel callback handler?

**Answer: yes, naturally re-entrant. R1's punt was overcautious.**

## Why it works

Three properties from R1 already make the wait loop intrinsically re-entrant:

1. **Each call uses a unique requestId** (atomic counter).
2. **Reply matching is by requestId, not slot order** — the wait loop scans
   all reply slots looking for the one with the caller's requestId.
3. **Shared-wake counter is bumped on every publish** (forward-reply AND
   reverse-request). Inner-call publishes wake the outer wait.

These together mean: outer call sleeps in `Atomics.wait` → inner call
runs (publishes forward, sleeps in its own `Atomics.wait`) → inner
reply arrives, bumps shared-wake → BOTH waits wake → inner sees its
reply, returns → outer resumes its wait loop, eventually sees its reply.

## Per-depth latency

| depth | iters | p50 | p99 | max |
|------:|------:|----:|----:|----:|
| 1     | 500   | 0.026–0.047 ms | 0.14–0.24 ms | up to 18 ms (warm-up) |
| 2     | 200   | 0.027–0.051 ms | 0.28–0.40 ms | 0.40 ms |
| 3     | 100   | 0.076–0.086 ms | 0.16–0.21 ms | 0.21 ms |
| 4     | 50    | 0.10 ms        | 0.15–0.44 ms | 0.44 ms |
| 6     | 25    | 0.18–0.20 ms   | 0.28–0.86 ms | 0.86 ms |

**Latency scales linearly with depth** (~30–50 µs per added level),
exactly the cost of one extra forward roundtrip per nest. No
super-linear blow-up, no contention pathology.

## Ring exhaustion: did NOT occur

This was the biggest surprise. Theory predicted depth ≈ NUM_SLOTS would
saturate the rings; in practice depth=16 worked fine with an 8-slot ring,
and depth=6 worked fine with a 2-slot ring.

**Reason:** at any instant, each in-flight call holds at most one slot,
and that slot turns over in microseconds:
- fwd-req slot is freed by host immediately upon pickup (before computing
  the reply).
- rev-req slot is freed by wasm's reverse handler before it recurses into
  the inner forward call.
- fwd-rep / rev-rep slots are freed by the receiver during scan.

**Ring sizing is governed by concurrent in-flight call width, NOT nesting
depth.** Depth is functionally unbounded by ring size.

(If a future implementation chose to hold the rev-req slot across the
recursive forward call — e.g. for cancellation or arg-lifetime reasons
— that would re-introduce a depth ≈ NUM_SLOTS cliff. Current design
correctly avoids that.)

## The re-entrant wait loop

```js
function sendForwardSync(opCode, ...args) {
  const requestId = allocReqId();           // (a) unique per call
  const slot = tryClaim(fwdReqI32);
  publishAndNotifyShared(fwdReqI32, slot, len, sharedWakeI32);
  let lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
  while (Date.now() < deadline) {
    drainReverseRequests();                 // (d) MAY RECURSE — calls sendForwardSync
    for (let s = 0; s < NUM_SLOTS; s++) {   // (b) match-by-requestId
      if (Atomics.load(fwdRepI32, slotStatusIdx(s)) !== STATUS_READY) continue;
      if (readReqId(s) !== requestId) continue;
      const result = readReply(s);
      freeSlotS(fwdRepI32, s);
      return result;
    }
    Atomics.wait(sharedWakeI32, SHARED_WAKE_IDX, lastWake, timeoutSliceMs);
    lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);   // (c) shared wake
  }
  throw new Error("sync RPC timeout");
}
```

## Production changes needed for `rpc-client-sync.ts`

1. **Inject reverse-drainer** as a constructor arg
   (`drainReverseRequests?: () => void`). Default no-op preserves
   current single-thread behavior.
2. **Call `this.drainReverseRequests()`** at the top of each wait-loop
   iteration, before the reply scan.
3. **Switch wait address** from the per-ring wake counter
   (`replyRing.i32[wakeIdx]`) to a SHARED wake counter (new Int32Array
   passed via constructor). All `publishSlot` paths — forward-reply AND
   reverse-request — must `Atomics.add` + `notify` this shared address.
   This is what makes inner reverse-requests wake the outer wait.
4. **Update the misleading comments:**
   - Lines 19-23: "concurrency limit: one in-flight call at a time" —
     becomes wrong with nesting. Multiple in-flight per client, scan
     handles it.
   - Lines 25-29: "Re-entrancy: ... DEADLOCK" — replace with a note
     that reverse-channel re-entry IS supported. Finalizers that need
     wasm response synchronously still need the pool/deferred pattern
     (R2 covered that).

**No depth counter needed.** No slot-holding changes. The mechanism is
intrinsic to the wait loop's design.

## Status for path (a)

**Risk retired.** Re-entrant napi callbacks (callback → napi op → another
callback → ...) work via the natural wait-loop re-entry. The
`rpc-client-sync.ts` production changes are surgical: 3 edits + 1
comment-rewrite, no architectural shift.

## R6b (JSPI re-entry from inside sync wait) is still open

R6a covers the SAB / Atomics / ring-management primitive. **R6b would
need a browser-side probe** to validate that invoking a wasm-table
funcref via `__indirect_function_table.get(idx)()` from inside an
`Atomics.wait` loop works under JSPI suspend semantics. Node has no
JSPI; this probe must run in browser.

R1 had the same structural concern and we trusted the analogy with
production wiring. Same call can be made for R6 — proceed to
production wiring on a feature branch, accept that JSPI behavior is
exercised implicitly during integration testing.

## Files

- `experiments/r6-nested-sync-rpc/probe.mjs`
- `experiments/r6-nested-sync-rpc/package.json`

Run with `npm run probe` or `NUM_SLOTS=2 node probe.mjs` for tight-ring
sweeps.
