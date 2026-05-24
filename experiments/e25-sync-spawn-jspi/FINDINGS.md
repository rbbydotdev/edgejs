# E25: WC sync-spawn trick under JSPI — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-aa23802c601cf6482` (port 5200)
**Result:** **The trick works, including under JSPI suspend.**  Confirms
edge.js can adopt synchronous `new Worker()` semantics for
`worker_threads.Worker`.

## Probe shape

Parent ran inside a Worker (Atomics.wait is illegal on the page).  It
spawned a child via Blob-URL Worker, IMMEDIATELY posted the bootstrap
message, then entered a blocking wait.  Main page handled `setTimeout`
+ `Atomics.notify`.

Three scenarios tested:
- **A. Atomics.wait** — direct blocking wait (~100ms)
- **B. await/setTimeout** — control (async wait)
- **C. JSPI suspend** — closest analogue to edge.js's `poll_oneoff`

## Scenario A (Atomics.wait) — observed timeline

```
t=  4.52  parent: bootstrap posted
t=  4.55  parent: pre Atomics.wait
t=  2.03  child: bootstrapMsgReceivedAt   (child's own clock)
t=  2.06  child: completedAt
t=106.13  parent: post Atomics.wait       (101.58ms blocked)
t=108.48  parent: sentinel received       (queued, drained after wait)
```

Child processed and completed at child-clock t≈2ms while parent was
blocked ~100ms.  Child's event loop ran concurrently.  Sentinel reply
queued in parent's mailbox during the block, drained ~2ms after wait
returned.

## Scenario C (JSPI suspend) — the edge.js shape

```
t=  4.38  parent: bootstrap posted
t=  5.00  parent: pre JSPI suspend (go())
t=  1.53  child: bootstrapMsgReceivedAt
t=  1.56  child: completedAt
t=105.67  parent: post JSPI suspend       (100.66ms suspended)
t=105.73  parent: sentinel received       (0.06ms gap — V8 drains microtasks at resume)
```

**Critical confirmation**: child Worker processed its queued bootstrap
message AND completed its synthetic work entirely DURING the parent's
JSPI suspend.  JSPI suspending the wasm frame does NOT freeze sibling
Workers — the child has its own event loop.  JSPI freezes only the
suspended JS context's continuation; the host worker's other tasks
(postMessage deliveries from child back to parent) still run.

## Scenario B (await/setTimeout) — control

Same shape: bootstrap posted at t=110, child received at child-clock
t≈2, parent unblocked at 217, sentinel arrived 0.11ms later.  Trick
works (though unnecessary in async case).

## Recommendation

**edge.js can adopt this pattern for sync-spawn of
`worker_threads.Worker`.**  Shape for the patched
`lib/internal/worker.js`:

1. Constructor synchronously spawns a child Worker pointing at a
   fixed bootstrap template URL.
2. Immediately `child.postMessage({ kind:"bootstrap", file, workerData,
   env, ... })` before returning the Worker handle.
3. Subsequent same-turn `worker.postMessage(...)` calls likewise queue
   and arrive in order.
4. Wasm parent does nothing special — first blocking I/O (JSPI
   suspend, sync-RPC, etc.) gives child plenty of wall-clock to
   bootstrap.

## Caveats — things that didn't compose as the WC blog implied

1. **Sentinel arrival is not instantaneous on parent.**  ~0.06ms
   (JSPI) to ~2.3ms (Atomics.wait) after parent resumes.  The reply
   queues during the block and drains on the next event-loop /
   microtask turn.  Node `worker.on('online', ...)` semantics will see
   this delay — probably fine since Node never promised sync online
   either.
2. **Sync-from-parent's-view only if parent blocks afterward.**  A
   parent that returns from `_start` without ever blocking will NOT
   see the child's first message before returning.  Real edge.js will
   always do some I/O, so this should hold, but be aware.
3. **JSPI drains microtasks at resume.**  The 0.06ms post-suspend gap
   implies V8 runs the microtask queue when unwinding the Suspender.
   Microtask-order code at the suspend boundary should be reviewed.
4. **Untested**: spawning a Worker from inside a JSPI-suspended
   callback.  We spawned BEFORE suspending (the realistic case).
   Spawning during suspend should work — Worker construction is a JS
   API call on the host worker — but unmeasured.
5. **Spike is non-isomorphic to real edge bootstrap.**  Used a 48-byte
   hand-encoded wasm with one Suspending import.  Mechanism is
   identical, but timing under realistic bootstrap load is unmeasured
   (E24 will get closer with real edgejs.wasm).

## What this means for phase 1

- The synchronous `new Worker(filename)` API is achievable.  No need
  to fall back to async-only.
- Pre-queue all bootstrap messages BEFORE any parent blocking call.
- Sibling Workers' event loops run independently of the parent's
  JSPI suspension.  This is the key property that makes the trick
  composable.
- `worker.on('online')` and the first `worker.on('message')` will
  fire at the next parent event-loop turn after a blocking call
  resolves — Node-compatible enough.

## Files in worktree (not merged)

- `experiments/e25-sync-spawn-jspi/main.ts` — page-side launcher
- `experiments/e25-sync-spawn-jspi/spike-parent-worker.ts` — parent
  Worker with the three scenarios
- `experiments/e25-sync-spawn-jspi/spike-child-worker.ts` — child
  bootstrap consumer
- `experiments/e25-sync-spawn-jspi/index.html`
- `experiments/e25-sync-spawn-jspi/vite.config.ts`
