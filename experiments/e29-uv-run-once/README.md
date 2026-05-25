# e29: UV_RUN_ONCE granularity

## Hypothesis to confirm/deny

`RunEventLoopUntilQuiescent` in `src/edge_runtime.cc` currently calls
`uv_run(loop, UV_RUN_DEFAULT)`, which runs until the loop has no more
work.  Per Path 2 in the experiments-menu writeup:

> Change to `uv_run(loop, UV_RUN_ONCE)`.  The outer loop then runs at
> single-libuv-iteration granularity, and `yield_for_microtasks` runs
> between every iteration instead of just between batches.

**Probe:** does finer granularity close between-iteration ordering
cases?  And what's the perf cost — more yields = more JSPI
suspend/resume cycles.

## Method

1. Locate the `uv_run` call in `src/edge_runtime.cc`
   (`RunEventLoopUntilQuiescent`, near the existing
   `yield_for_microtasks` site at line 1865).
2. Patch UV_RUN_DEFAULT → UV_RUN_ONCE.  Ensure the wrapping loop
   continues calling RunEventLoopUntilQuiescent's body until
   `uv_loop_alive` returns false (UV_RUN_ONCE returns 1 if more work,
   0 if done).
3. Rebuild wasm.
4. Run 5 ordering tests × 5 each.
5. Run e27 canary × 5.
6. Run `browser-perf-runner.mjs` to measure perf impact.
7. Save patch as `patch.diff`.

## Gating

Run AFTER e28.  If e28 closes everything, e29 may be unnecessary.  If
e28 doesn't close within-iteration cases, e29 should be evaluated as
a complement (within-iteration won't close via UV_RUN_ONCE alone — that
needs e28 or a deeper change — but inter-iteration becomes tighter).

## Success criteria

- Ordering tests pass + perf delta &lt;10% → ship.
- Ordering tests pass + perf delta 10-30% → mark as opt-in policy.
- Perf delta &gt;30% → record as debt, don't ship; explore other paths.
- No ordering improvement → unsurprising for within-iteration; still
  document as a confirmation of where UV_RUN_ONCE helps vs doesn't.

## Output

`FINDINGS.md` + `patch.diff` + perf-delta numbers in this directory.
