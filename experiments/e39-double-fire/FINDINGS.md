# E39 — unhandled-rejection double-fire (actually: process.exit not honored)

## Reproduction

Baseline (no fix to wasi-shim line 1122):
```
$ cd browser-target && git stash
$ node scripts/browser-test-runner.mjs unhandled-rejection
  ok  unhandled-rejection-fires
1 pass, 0 fail
```

With fix applied:
```
$ git stash pop
$ node scripts/browser-test-runner.mjs unhandled-rejection
  FAIL  unhandled-rejection-fires (non-zero exit (1))
expected: caught:Error: boom
actual:   caught:Error: boom
          handler did not fire
```

## Mechanism revealed by e39 probe

Probe added a counter inside the handler + a log AFTER `process.exit(0)`:

```
[e39] handler-call=1 t=35 reason=Error: boom
[e39] AFTER process.exit(0) — should never see this
[e39] timer-100ms fired t=138 handler-called=1×
_start ran 233 ms (exit=1)
```

**Key finding:** `process.exit(0)` inside the unhandledRejection handler
DOES NOT TERMINATE in this V8/edge.js setup.  Execution continues past
the `process.exit(0)` call.  The safety timer fires at t=100ms and
calls `process.exit(1)` which DOES eventually take effect (after another
100ms or so).

So the regression isn't "fires twice" (my earlier hasty read) — it's
that the line-1122 fix changes the microtask / loop-iteration ordering
such that `process.exit(0)` called from inside the
`unhandledRejection` handler is queued but never checked before the
safety timer fires.

## Hypothesis on mechanism (not fully verified)

- WITHOUT fix: `pollOneoffAsyncImpl` takes the timer-only branch →
  `pollOneoffAwaitTimer` → suspends via `Atomics.waitAsync` on a timer
  SAB → wakes on timeout → resumes.  Between iterations, microtasks
  drain (V8's kAuto policy at the suspend boundary).  process.exit's
  flag (`IsProcessExiting(env)`) gets checked in `RunEventLoopUntilQuiescent`
  promptly.

- WITH fix: `pollOneoffAsyncImpl` falls through to race-of-waiters →
  returns a Promise wrapping `Promise.race(racers).then(...)`.  The
  Promise resolution may queue differently relative to the
  unhandledRejection handler's microtask context.  The `process.exit`
  flag is set, but RunEventLoopUntilQuiescent's exit-condition check
  may happen LATER (or not at all) because the loop iteration
  ordering differs.

Confirming this would require:
1. C++-side instrumentation logging `IsProcessExiting(env)` value at
   the top of each RunEventLoopUntilQuiescent iteration
2. Trace of microtask drain vs uv_run boundary timing with the fix

Out of scope for this round.

## Decision

**Do NOT apply the wasi-shim line-1122 fix in isolation.**

The fix is correctly identified as a real bug in the wake-up routing.
But:
- It doesn't enable Real Path A end-to-end (per e37 + e38: _start
  still exits at ~144ms with our keepalive ref'd, root cause unknown).
- It DOES cause this regression in `process.exit` semantics inside an
  unhandledRejection handler.

Both gaps need further investigation before the fix ships.  Until then,
the `setInterval(100ms)` keepalive in the worker_threads policy remains
the working keepalive, accepting the 100ms wake latency.

## What we learned (knowledge)

1. `process.exit()` in this V8/edge.js setup is NOT immediate.
   Execution can continue past it (we observed "AFTER process.exit"
   log printing).
2. `process.exit(0)` from inside an unhandledRejection handler doesn't
   take effect promptly — its actual termination depends on subsequent
   `RunEventLoopUntilQuiescent` iterations checking `IsProcessExiting`.
3. Even without the line-1122 fix, the test passes only because the
   timer-only path happens to give `RunEventLoopUntilQuiescent` a
   chance to honor `process.exit` before the safety timer.  Brittle.

This is itself worth a separate investigation: `process.exit()` should
be more predictable than this.
