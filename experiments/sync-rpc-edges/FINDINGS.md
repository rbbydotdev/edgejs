# Q5: sync RPC failure modes — findings

**Date:** 2026-05-23
**Result:** Worker-crash detection validated; ring-full + reply-loss
behaviour designed but not yet probed.

## Worker crash mid-RPC (probe-worker-crash.mjs)

**Scenario:** host issues sync RPC + Atomics.wait.  Worker dies
before responding.

**Result:**
```
[main] worker exited (code=0)
[main] issued RPC; waiting for reply with 1s timeout...
[main] Atomics.wait returned "timed-out" after 1010ms
[main] OK — detected worker death via timeout + exit event
```

**Resolution:**
- Host's RPC client uses `Atomics.wait` with a finite timeout (default
  e.g. 30s for slow napi calls; 1s for fast ones).
- When timeout fires AND `worker.exit` event has been observed:
  reject the pending RPC promise with `WorkerDeadError`.
- When timeout fires but worker is alive: probably a real
  slow op; surface a `RpcTimeoutError` with op + requestId.
- The pending-replies map in our `rpc-client.ts` lets us cleanly
  reject all in-flight calls when worker dies.

## Ring-full backpressure (designed, not probed)

**Scenario:** wasm worker tries to send RPC; request ring has no
empty slot.

**Current design** (`browser-target/src/host-worker/rpc-client.ts:48-58`):
```js
for (let attempt = 0; slot === -1 && attempt < 100; attempt++) {
  slot = tryClaimSlot(...);
  if (slot === -1) {
    await new Promise((r) => setTimeout(r, 1 << Math.min(attempt, 6)));
  }
}
```

Exponential backoff up to 64ms per attempt, 100 attempts max.  Total
worst-case wait: ~3.2s.  Then throws `request ring full after backoff`.

**Improvement targets** (post-L5 if needed):
- Tune backoff (less time per iteration; more iterations)
- Use Atomics.waitAsync on a wake-when-slot-free signal instead of
  blind retry
- Bigger ring (more slots) — cheap if memory allows

## Reply ring full

**Scenario:** host's RPC server can't write a reply because reply ring
is full (caller hasn't drained).

**Current handling** (`browser-target/src/host-worker/rpc-server.ts:152-156`):
```js
if (slot === -1) {
  console.warn(`[rpc-server] reply ring full; dropping reply for op ...`);
  return;
}
```

Reply is dropped.  The caller (wasm worker) times out waiting; its
RPC promise rejects with timeout.  Caller treats as a transient
error.

This is suboptimal — the work was DONE but the result lost.  For
napi ops that mutate state (most of them), the side effects already
happened but the wasm side doesn't know.

**Improvement targets:**
- Spin briefly waiting for reply slot to free (currently does this,
  but with bad UX).
- Make reply ring bigger than request ring (so it never fills first).
- Could add a "post-response" message channel (postMessage fallback)
  for replies that couldn't fit in the ring.

## Timeout semantics summary

| Scenario | Behaviour |
|---|---|
| Wasm worker alive but slow | Atomics.wait timeout → RpcTimeoutError |
| Wasm worker dead | Atomics.wait timeout + worker.exit → WorkerDeadError |
| Request ring full | Exponential backoff → request-ring-full error after ~3s |
| Reply ring full | Reply dropped; caller times out |
| Multiple RPCs in flight, one fails | Other RPCs unaffected (requestId demux) |

## What's NOT covered yet

- **Deadlocks**: Q1 handled the malloc one.  Others may exist.
  Production stress test (1000+ concurrent RPCs) might surface
  more.
- **Memory exhaustion**: pool runs out (Q1 follow-up).
- **GC of pending RPC promises** when worker dies: probably handled
  by the rpc-client's pending map, but worth verifying when L5 lands.
- **Recovery**: do we re-spawn the wasm worker?  Mark the runtime
  dead?  Up to higher-level policy.

## Recommendation

For L5 F-1 ship: accept the current designs (`rpc-client.ts` backoff,
reply ring drop on overflow).  They're correct in the steady state.
Robustness improvements are post-foundation work — file as NOTES.md
debt entries when they bite.

## No additional probe code needed

Worker-crash probe demonstrates the detection pattern.  Ring-full and
reply-full are architectural designs whose correctness is reviewable
in source.  No simulation buys more confidence than reading the code.
