# R2: finalizer dispatch across the host/wasm split — findings

**Date:** 2026-05-23
**Result:** PASS — finalizer dispatch is reliable enough to wire in
production, with one batching caveat documented below.

## The question

In Lever B's full-napi-cutover topology, `napi_add_finalizer` poses a
split-ownership problem:

- The **JS value** lives on host (host's V8 owns the GC).
- The **finalize callback** is a wasm-table funcref — it lives on the
  wasm worker.

We need: host detects "this JS value is no longer reachable" → reverse
RPC to wasm → wasm `dynCall(fnptr)(env, data, hint)`.

This probe validates that V8's `FinalizationRegistry`, combined with
`--expose-gc`-forced cycles and a postMessage reverse channel, gives us
deterministic-enough behavior to base production wiring on.

## Topology

```
   main thread  ←──── reverse channel (postMessage) ──── worker thread
   "wasm worker"                                          "host worker"
   - registers fnptrs via fake                            - owns JS values + FinalizationRegistry
     napi_add_finalizer                                   - drops refs, forces GC, observes
   - receives {fnptr, hint} messages                        registry callbacks
     and would dynCall(fnptr)(env,...)                    - posts {kind:'finalize', fnptr, hint}
                                                            back to wasm
```

12 values registered. 3 kept alive (KEEP_ALIVE first). 9 expected to
finalize.

## Observations (n=5 runs)

| metric                                   | value |
| ---------------------------------------- | ----- |
| expected finalizers                      | 9     |
| actually fired                           | 9 (5/5 runs) |
| ordering                                 | **LIFO** (reverse registration order) — stable across all 5 runs |
| batching                                 | almost always a single tick (4/5); occasional 2-tick split (1/5) |
| latency: drop-and-gc → all finalizers    | 45–83 ms from probe start; typically within one setImmediate after `globalThis.gc()` |
| missing finalizers                       | 0 |
| spurious finalizers (kept-alive fired)   | 0 |

Sample fired sequence (hints): `11, 10, 9, 8, 7, 6, 5, 4, 3` —
registered in order 0..11, KEEP_ALIVE = {0,1,2}, drops = {3..11}.
Fires LIFO over the drop set.

## What this tells us about V8

1. **LIFO is real.** V8's `FinalizationRegistry` (Node 24) drains its
   cleanup queue last-in-first-out for objects collected in the same
   GC pass. This is implementation-defined per ECMA-262 (cleanup
   callbacks are "best-effort"), but it has been stable in V8 for
   several years. **We must not rely on it for correctness, but we
   can document it.**
2. **Same-GC-pass batching.** All 9 finalizers from one GC pass
   typically fire in a single registry callback drain. The 2-tick
   split observed once is consistent with V8 splitting cleanup work
   across microtask budgets under load.
3. **`globalThis.gc()` is sufficient + necessary for tests.** Without
   forced GC, registry callbacks are not guaranteed to fire at all
   (per spec) and in practice may not fire before process exit.
   Production must not depend on forced GC.

## Reverse-channel concerns

The probe uses worker_threads `postMessage` for the host→wasm reverse
channel. Findings:

- `postMessage` is a structured-clone send into the recipient's event
  loop. If the wasm worker is mid-synchronous-work, the messages queue;
  they drain when wasm next yields.
- This is exactly the behavior we want for L5: finalizers cannot
  interrupt wasm; they observe ordering relative to wasm's "task
  boundaries", not relative to wasm's instructions.
- In Lever B's real wiring the reverse channel is the L4 SAB ring, not
  `postMessage`. Same semantics: wasm polls the ring at safe points;
  finalizer dispatch waits for those points. **No correctness change.**

## What happens if wasm is busy when host wants to dispatch?

Two cases, both safe:

1. **Wasm in a long synchronous loop:** host enqueues `{fnptr,hint}`
   on the reverse-channel ring. Ring is bounded; if it fills, host
   blocks or grows. Recommend bounded ring + grow-on-overflow with a
   warning, since finalizers should be rare relative to napi ops.
2. **Wasm itself currently running a finalizer:** the dispatched
   finalizer runs `dynCall(cb)(env, data, hint)`, which itself can
   call napi ops, which go right back over forward-RPC to host. As
   long as forward-RPC is reentrant from a finalizer context (it is —
   it's just a SAB write + wait), no deadlock.

## Ordering: does it matter?

Node's own docs say finalizers fire "after the value is no longer
reachable" with no timing guarantee relative to user ops or to other
finalizers. So:

- emnapi's host-side `setImmediate(drainFinalizerQueue)` enqueues
  pending finalizers and drains them in one shot. The Reference
  weak-callback path (`runtime/src/Reference.ts:19`, `runtime/src/Persistent.ts:51`)
  is what feeds it.
- **In our split:** the same `setImmediate(drainFinalizerQueue)` runs
  on host. Each drained finalizer turns into a reverse-RPC. Wasm sees
  them in whatever order host drained.
- V8's LIFO is therefore the ordering wasm will observe, **modulo
  reverse-ring drain semantics** (FIFO ring → wasm sees them in the
  order host enqueued them, which is the order host's registry
  yielded them, which is LIFO).

## Production recommendation

**Buffer + drain at safe points. Do not fire reverse RPC inline from
the registry callback.**

Concrete wiring:

1. Host registers each `napi_add_finalizer` registration with a
   single shared `FinalizationRegistry` whose heldValue is
   `{envId, fnptr, dataPtr, hintPtr}`.
2. Registry callback **does not** issue reverse RPC immediately.
   Instead it pushes onto a host-side `pendingFinalizers` queue and
   schedules a `setImmediate` (same pattern emnapi already uses for
   the v1 in-process case — `runtime/src/env.ts:299–310`).
3. The setImmediate drains the queue by writing each entry onto the
   reverse-channel SAB ring (one entry per finalizer; bounded ring,
   grow-on-overflow).
4. Wasm polls the reverse ring at its existing safe points (between
   napi RPC calls, at top of event loop). For each entry: lookup
   fnptr in the indirect table, `dynCall_vppp(cb, env, data, hint)`.

Rationale:

- Decouples GC timing from RPC timing → easier to reason about.
- Batches multiple finalizers into one ring transaction when GC
  reaped many at once.
- Matches what emnapi already does in-process; minimal architectural
  novelty.
- Keeps registry callback short (just an array push) → V8's
  cleanup-budget heuristic stays happy.

## What's NOT validated by this probe

- Behavior when wasm-side `dynCall(cb)(env, data, hint)` itself
  triggers more napi ops that allocate more references that need
  finalizers. Reentrancy should work but is untested here.
- Behavior across env teardown — when the napi env is being destroyed,
  emnapi calls `drainFinalizerQueue` synchronously. The reverse-channel
  delivery would need a sync flush path. **F-N task.**
- Behavior under memory pressure with millions of refs. We tested 12.
  Reverse-channel ring sizing is the only concern at scale.

## Files

- `probe.mjs` — runnable probe (12 registrations, 3 kept alive, 5x stable)
- `package.json` — `npm run probe` (passes `--expose-gc`)
