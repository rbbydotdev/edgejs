# Phase 2 experiments — synthesis

Three experiments, three definitive answers, one shipping change: NONE.

## e37 — Does `uv_run` block on a ref'd async handle?

**Answer:** `uv_loop_alive(loop)` returns 1 throughout (before, during,
and after `_start`).  But `_start` "returns" at ~144ms anyway —
`RunEventLoopUntilQuiescent`'s `uv_run(UV_RUN_DEFAULT)` returns despite
the alive flag being set.  This contradicts libuv spec.

**Implication:** the libuv `active_handles` accounting works.  The bug
is in HOW `uv_run` decides to return.

## e38 — poll_oneoff sub trace

**Answer:** During the failing scenario, only ONE poll_oneoff call
sees our async pipe sub (call #9: `nsubs=3 minTimeoutNs=1
pipeReadSubs=2`).  That call takes the broken TIMER-ONLY branch
(line 1122 of wasi-shim.ts).

**With the line-1122 fix applied:** call #9 correctly enters the
race-of-waiters branch.  BUT `_start` STILL exits at ~144ms — only ONE
call to poll_oneoff with our pipe sub.  After that single call resolves,
`uv_run` returns AND `RunEventLoopUntilQuiescent` exits.

**Two implications:**

1. The line-1122 fix is a correct fix for one branch routing bug, but
   NOT the root cause of the keepalive failure.
2. Something else (in `RunEventLoopUntilQuiescent` or `uv_run` itself)
   is making the loop exit despite our ref'd handle.

## e39 — unhandled-rejection regression

**Answer:** With the line-1122 fix applied, `process.exit(0)` called
from inside an `unhandledRejection` handler does NOT take effect
promptly.  Execution continues past the exit call.  Safety timer at
100ms fires and ITS `process.exit(1)` eventually wins.

The regression is caused by the line-1122 fix changing microtask /
loop-iteration ordering such that `IsProcessExiting(env)` is not
checked by `RunEventLoopUntilQuiescent` before the safety timer fires.

**Implication:** the line-1122 fix has at least one unintended
microtask-ordering side effect.  Even if we found the right additional
fix for the keepalive issue, we'd need to also understand and resolve
this regression.

## Final state

**Code shipped from this round of investigation:** NONE.

**Knowledge gained (research artifacts):**

- `e23-real-path-a-discovery/` (pre-existing) — uv_async wake-up
  feasibility, the Real Path A design
- `e35-uv-async-keepalive-probe/` — proved libuv keepalive accounting
  works; `uv_loop_alive` returns 1 with our handle ref'd
- `e36-async-wfd-probe/` — proved `uv_async_send` reaches
  `pipeRegistry.write` (the write side works end-to-end)
- `e37-uvrun-blocks/` — proved `uv_run(UV_RUN_DEFAULT)` returns
  despite `uv_loop_alive == 1`, contradicting libuv spec
- `e38-polloneoff-trace/` — found the real line-1122 bug in
  wasi-shim, proved the fix is NECESSARY but NOT SUFFICIENT
- `e39-double-fire/` — exposed an unrelated microtask-ordering
  regression caused by the line-1122 fix

## Why we still ship `setInterval(100ms)` keepalive

It's the simplest correct mechanism we have:
- Each 100ms timer tick IS a wake — message delivery latency cap is 100ms
- Works regardless of the underlying bugs found above
- Trade-off: heartbeat CPU cost (~10 wakeups/sec/worker idle)

To replace it with Real Path A (zero-heartbeat), we need:

1. The line-1122 fix in wasi-shim.ts (e38 — necessary)
2. Root cause + fix for why `uv_run` returns despite alive=1 (e37)
3. Root cause + fix for the microtask-ordering regression (e39)

All three together.  Until then, `setInterval` is correct & shipping.

## Recommended next steps (when this becomes a priority)

1. **e40 (next probe):** add C++ instrumentation to
   `RunEventLoopUntilQuiescent` and `uv_run`'s exit path.  Log:
   - `IsProcessExiting(env)` at each iteration
   - `uv_loop_alive(loop)` immediately before and after each `uv_run`
     call
   - `uv__io_poll` entry/exit timing
   This should pinpoint why `uv_run` returns.

2. **e41 (after e40 reveals (2)):** apply the (2) fix + line-1122 fix
   together, re-run e39, see if the regression resolves.

3. Only ship if all of {line-1122 fix, the deeper `uv_run` fix, and
   resolved unhandled-rejection regression} hold together.

## Methodology that worked

- ALL probes wrote success criteria BEFORE running
- Each probe answered ONE question definitively (or explicitly
  acknowledged "inconclusive" and refined methodology)
- No claims of "fixed" without baseline → test → baseline cycle
- Every probe documented its findings before moving on

This is a model for future investigations on this codebase.
