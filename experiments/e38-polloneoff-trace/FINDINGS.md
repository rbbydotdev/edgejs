# E38 — poll_oneoff trace: findings

## What the trace showed

Without the line-1122 fix:
```
[e38-keepalive] engaged
[e38-user] bootstrap-done
[e38][async-call#1..8] nsubs=1 minTimeoutNs=1000000 hasSocketSub=false pipeReadSubs=0
[e38][async-call#9]    nsubs=3 minTimeoutNs=1       hasSocketSub=false pipeReadSubs=2
[e38][async-call#9] → about to take TIMER-ONLY branch
_start ran 145 ms (returned)
```

With the line-1122 fix:
```
[e38][async-call#9] → falling through to RACE branch (pipeReadSubs=2)
_start ran 142 ms (returned)
```

## Definitive conclusions

### A) The line-1122 bug is real
With `pipeReadSubs=2` AND `minTimeoutNs >= 0`, the unpatched code takes
the TIMER-ONLY path which never listens to pipe wakes.  Confirmed by
trace.  Fix: `&& r.pipeReadSubs.length === 0` to the condition.

### B) The line-1122 fix is INSUFFICIENT
Even with the fix routing call #9 into the race-of-waiters branch,
`_start` still returns at ~144ms.  Only ONE call ever sees our pipe
sub.  The loop is exiting for a deeper reason.

### C) The exit happens despite `uv_loop_alive == 1`
From e37, `uv_loop_alive(loop)` returns 1 throughout (including during
and after _start exits).  Yet `RunEventLoopUntilQuiescent` exits with
"(returned)" — `_start` function returned normally, not via ExitSignal
or exception.

### D) Only ONE poll_oneoff call ever has our async sub
Calls 1-8: bootstrap-only (1ms timer, no pipes).  Call 9: bootstrap
completes, our async + wq_async both register.  Then exit.

This means after call 9 resolves, `uv_run` ITSELF returns to its
caller (`RunEventLoopUntilQuiescent`'s `uv_run(loop, UV_RUN_DEFAULT)`
call), and that caller exits.  The mystery: WHY does `uv_run` return
if the loop is alive?  Possible causes (need C++ instrumentation to
distinguish):

- `uv_run`'s internal check finds nothing to do (poll returns 0 events
  with timeout=0 from `uv_backend_timeout` → not blocking).
- Some `process.exit`-like signal fires after the user script ends.
- `RunEventLoopUntilQuiescent`'s `IsProcessExiting(env)` flag is true.

## Where this leaves us

To fully fix Real Path A we need ALSO:
1. Apply the line-1122 fix to wasi-shim.ts (necessary but not sufficient)
2. Figure out why `uv_run(UV_RUN_DEFAULT)` returns after call 9 despite
   alive=1.  Requires C++-side instrumentation in edge_runtime.cc to
   log which `uv_run` call returns AND what state the loop is in.

Both are non-trivial.  Estimate: another full investigation cycle
(more probes, possibly C++ rebuild) to nail down (2).

## Recommended action

**Do NOT ship the line-1122 fix in isolation.**  Even if it's correct,
it has the unhandled-rejection regression (see e39) AND doesn't deliver
the user-visible improvement (Real Path A still doesn't keep the loop
alive end-to-end).

Park Real Path A.  Keep the `setInterval(100ms)` keepalive shipping.
File a follow-up probe (e40?) to add C++ instrumentation tracking why
RunEventLoopUntilQuiescent exits.  Resume from that knowledge.

## What we LEARNED (knowledge gained, even if no code shipped)

1. Phase 1 research correctly characterized the chain at every layer.
2. wasi-shim line 1122 IS buggy (timer-only branch ignores pipe subs).
3. The bug fixed by line-1122 is NOT the only one blocking Real Path A.
4. `uv_run(UV_RUN_DEFAULT)` returns despite `uv_loop_alive == 1` in our
   wasi build — a behavior that contradicts libuv spec and needs further
   investigation.
5. Methodology that works: instrument the actual code paths, log every
   decision point, verify probe gives definitive answers before drawing
   conclusions.  This experiment did that successfully.
