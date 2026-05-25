# e27 — Within-iteration ordering canary: FINDINGS

## Verdict

**Hypothesis CONFIRMED, with a stronger-than-predicted symptom.**

The SHIPPED fix `cf306ee4`'s pre-`uv_run` `yield_for_microtasks` drain does
NOT cover the within-iteration case where two `setTimeout(0)` callbacks
are due in the same libuv tick. Worse than predicted: the queued microtask
isn't merely reordered — it's never observed at all, because `process.exit(0)`
in `timer2` tears the loop down before any microtask drain runs.

Predicted wasm output: `timer1,timer2,microtask`
Actual wasm output:    `timer1,timer2`   (microtask dropped entirely)

## 10-run table

Test: two back-to-back `setTimeout(0)` callbacks; timer1 schedules a
microtask; timer2 logs and `process.exit(0)`. Expected (Node-correct):
`timer1,microtask,timer2`.

| Run | Path    | Verdict | Actual stdout            |
|-----|---------|---------|--------------------------|
| 1   | wasm    | FAIL    | `timer1,timer2`          |
| 2   | wasm    | FAIL    | `timer1,timer2`          |
| 3   | wasm    | FAIL    | `timer1,timer2`          |
| 4   | wasm    | FAIL    | `timer1,timer2`          |
| 5   | wasm    | FAIL    | `timer1,timer2`          |
| 6   | host=1  | PASS    | `timer1,microtask,timer2`|
| 7   | host=1  | PASS    | `timer1,microtask,timer2`|
| 8   | host=1  | PASS    | `timer1,microtask,timer2`|
| 9   | host=1  | PASS    | `timer1,microtask,timer2`|
| 10  | host=1  | PASS    | `timer1,microtask,timer2`|

Zero flake on either path across 10 runs.

## Interpretation

Two failure modes are tangled here:

1. **Within-iteration drain hole** (predicted by e23-redo): when uv_run
   processes both due timers in one iteration, no microtask checkpoint
   runs between them. `timer1`'s `queueMicrotask` callback is enqueued
   but the host doesn't drain before invoking `timer2`.
2. **`process.exit` short-circuit** (newly surfaced): once `timer2`
   calls `process.exit(0)`, the loop tears down before the next pre-uv_run
   drain pump fires. So the queued microtask is silently dropped — no
   stdout line, no error.

`process.exit` matching Node's "abrupt — pending microtasks discarded"
semantics is arguably correct in isolation. But here it COMPOUNDS the
ordering hole: in a Node-correct build the microtask would have already
run between timer1 and timer2, so exit can't drop it. Under wasm it never
got the chance, so it vanishes.

Host=1 (browser V8 kAuto microtask policy) drains automatically between
each timer callback, so exit-after-timer2 happens AFTER the microtask
already ran. Five-for-five clean.

## Recommendation

**Run e28** — the within-iteration drain hole is real, observable, and
strictly worse than the README predicted (silent data loss, not just
reorder). Dropping `kSkipTaskQueues` on the timer-callback path (or
inserting an explicit `PerformCheckpoint` between same-iteration timer
fires, mirroring Node's `runNextTicks()` at `lib/internal/timers.js:566-567`)
should close it. e28 worth doing.
