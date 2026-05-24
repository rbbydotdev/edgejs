# E8: microtask checkpoint pump spike — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a1cb74509fa32ee95` (port 5183)
**Result:** **NOTES followup #1's premise was partly wrong.**  Microtasks
DO drain on the wasm path under JSPI suspension; the `Atomics.waitAsync`
path is sufficient.  Two of the four target tests already pass on the
wasm path without any change.  The remaining two have **different root
causes** than microtask drain — they need separate investigation, not
an Asyncify-at-syscall-boundary fix.

## The hypothesis going in

NOTES followup #1 (lines ~418-510) claimed:
> Edge's `_start` runs as ONE long synchronous task on the worker
> thread.  It never returns to the worker's event loop, so no task
> boundary fires, so microtasks never drain.

Spike approach: in `poll_oneoff`'s timer-only branch, replace the
`Atomics.wait` with `setTimeout(resume, durationMs)` to force a task
boundary — letting the worker's event loop turn and microtasks
drain — before resuming wasm.

## Critical empirical finding

Tested three primitives under JSPI suspension on the wasm worker:

| Primitive | Fires during JSPI suspension? |
|---|---|
| `Promise.resolve().then(...)` (microtask) | **Yes** ✓ |
| `setTimeout(..., 1ms)` (macrotask) | **No** ✗ — deadlocks |
| `Atomics.waitAsync(..., 1ms).value` (engine timer) | **Yes** ✓ |

The literal text of NOTES followup #1 approach (b) — "setTimeout
(resume, N)" — **cannot be implemented**.  The worker's macrotask
queue freezes while wasm is JSPI-suspended (V8 has the worker
thread parked at the C++ layer; macrotasks need the host loop to
dispatch them, which can't happen during the JSPI await).

But microtasks DO run because V8's own microtask scope is
processed during the wait.  This invalidates the broader premise
("microtasks never drain") — they drain at every JSPI resumption.

## Test results

The 4 originally-skipped microtask-related tests, on the wasm path
(no e8 changes), with `host=1` harness arg removed:

| Test | Wasm-path verdict (verified) | Original framing |
|---|---|---|
| `regression-lazy-load-from-microtask` | **PASS** (3/3 runs) | "microtasks never drain" |
| `regression-microtask-not-starved` | **PASS** (3/3 runs) | "microtasks never drain" |
| `finalization-registry-runs` | **Still fails** — output `finalized:A\nnot fired`.  ClearKeptObjects DOES run; the finalizer fires; bug is `process.exit(0)` inside the finalizer doesn't prevent the surviving `setTimeout(200)` from firing.  Reclassify: `process.exit` semantics issue. | "ClearKeptObjects never runs" |
| `unhandled-rejection-fires` | **Still fails** — output `handler did not fire\ncaught:Error: boom`.  Handler IS captured and IS fired, just AFTER `setTimeout(100)`.  Bug is `process.nextTick`/`tickCallback` drive timing between poll_oneoff iterations. | "lib defers emission via tickCallback" |

The other 5 `host=1` microtask-ordering tests (await-resumes,
microtask-before-timer, nexttick-before-microtask, promise-chain,
queuemicrotask): partially pass on wasm path (2/5 confirmed pass:
await-resumes, queuemicrotask).  The other 3 are flaky or fail
on specific ordering semantics; keep `host=1` for those.

## Implementation (spike code; not merged)

File: `browser-target/src/wasi-shim.ts` (~lines 940-1010,
`pollOneoffAwaitTimer`).  Gated behind `?e8pump=1`.  Adds 12 extra
`await Promise.resolve()` yields around the `Atomics.waitAsync`
call.  Original setTimeout-based approach was reverted after the
worker deadlock was observed.

```ts
async function pollOneoffAwaitTimer(ms, dv, inPtr, outPtr, ...) {
  if (e8Pump) {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  const r = waitAsync(sleepI32, 0, 0, ms);
  if (r.async) await r.value;
  if (e8Pump) {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }
  // ... emit events, return ERRNO_SUCCESS
}
```

With e8pump enabled globally:
- 25/25 baseline tests still pass
- Suite wall-clock: 10.69s → 10.99s (+2.8%)

Per-timer-fire overhead from the extra microtask yields: ~0.15-0.4ms.

## Perf characterization (with e8pump on)

| Workload | Baseline | With e8pump | Delta |
|---|---|---|---|
| Full suite | 10.69s | 10.99s | +2.8% |
| Per-test impact (5x poll_oneoff fires) | n/a | ~1-2ms added | <5% |

Within the &lt;5% target.  Not enough benefit to justify shipping —
the extra microtask yields don't change any test outcomes.

## Recommendation

**Punt on (b) as proposed.**

1. Premise is partly wrong: microtasks already drain via JSPI.
2. `setTimeout`-from-poll_oneoff deadlocks under JSPI.  Approach (b)
   cannot be implemented without real wasm-stack-switching (Asyncify,
   approach c).
3. The two remaining failures are **different bugs**, not microtask
   drain issues:
   - `finalization-registry-runs`: `process.exit(0)` inside the
     finalizer callback doesn't terminate before the surviving
     `setTimeout(200)` fires.  Likely root cause: the finalizer is
     called from a microtask context where the exit throws but
     `_start` already returned past that frame.  Worth a separate
     investigation.
   - `unhandled-rejection-fires`: handler IS fired, just AFTER a
     surviving `setTimeout(100)`.  Likely root cause: lib's
     `process.nextTick(emit)` doesn't drive between
     `poll_oneoff` iterations on the wasm path.

4. The spike's kept code (12 extra `Promise.resolve()` yields) is
   opt-in, costs ~3%, doesn't fix the bugs.  **Revert in main.**

## Strategic implications

NOTES followup #1's framing ("needs novel solution",
"Asyncify-at-syscall-boundary") was based on the wrong premise.
The microtask drain "bug" doesn't fully exist as documented.  This
SIGNIFICANTLY weakens the Lever B argument that "user JS on host
collapses the microtask drain bug" — the wasm path already drains
microtasks at every JSPI resumption.

What this means for the Lever B / in-process tradeoff:
- The "microtask drain" reason for moving user JS to host is much
  weaker than NOTES suggested.
- The wasm path is more capable than the docs claimed.
- The 2 regression tests can move off `host=1` (action taken in main).
- The 5 microtask-ordering `host=1` tests still benefit from host
  V8's native event loop for their specific ordering semantics.

The remaining motivations for Lever B (ESM via native loader,
worker_threads, optional native-V8 perf) stand on their own merits
but should be re-evaluated against their actual costs rather than
the now-discredited microtask-drain argument.

## Open questions for follow-up

1. `process.exit(0)` inside a `FinalizationRegistry` callback —
   why doesn't it terminate `_start`?  Likely: finalizer runs in
   microtask context where the exit throws but `_start` already
   returned past that frame.  Worth a separate investigation.
2. Why does `lib/internal/process/promises.js`'s
   `emitUnhandledRejection` defer via `process.nextTick` instead of
   firing immediately?  Is this Node-honest behavior we should
   respect, or a regression?
3. Approach (a) emnapi multithreaded mode — given microtasks
   already drain, is the structural cost still justified?  Probably
   not for the microtask reason alone, but may still help with
   ESM / worker_threads.

## Files in worktree (not merged)

- `browser-target/src/wasi-shim.ts` — gated microtask yields around
  `pollOneoffAwaitTimer`
- `browser-target/src/main.ts` — read `?e8pump=1`
- `browser-target/src/worker.ts` — forward flag to runtime worker
- `browser-target/scripts/_runner-common.mjs` — VITE_PORT 5183

## Actions taken in main (post-spike verification)

- Dropped `host=1` from `tests/js/regression-lazy-load-from-microtask.harness-args`
- Dropped `host=1` from `tests/js/regression-microtask-not-starved.harness-args`
  (both verified 3/3 stable runs on the wasm path)
- Updated NOTES followup #1 with the corrected premise
- Reclassified `finalization-registry-runs` and
  `unhandled-rejection-fires` skip reasons (process.exit semantics +
  nextTick timing, not microtask drain)
