# e26 — Verify ground truth on 5 ordering tests: FINDINGS

## Verdict

**SHIPPED commit `cf306ee4` (2026-05-24) is solid for the 5 tests in scope.
25/25 pass on the wasm path.**

The hypothesis "are these 5 tests actually stable today?" answers cleanly:
**yes**. No flake, no failures, no `.harness-args` sidecars resurfaced,
no `.skip` files present. The earlier conversational context claiming
"still routed via host=1" was stale.

## Pre-flight

- Tests live at `tests/js/` at project root (NOT `browser-target/tests/js/`).
- All 5 `.js` + `.stdout` files present.
- No `.harness-args` sidecars for any of the 5 — matches SHIPPED cutover.
- No `.skip` files for any of the 5.
- Used existing wasm artifact, no rebuild.

## 25-run table

| Test                                  | r1 | r2 | r3 | r4   | r5 | total |
| ------------------------------------- | -- | -- | -- | ---- | -- | ----- |
| microtask-before-timer                | ok | ok | ok | ok   | ok | 5/5   |
| nexttick-before-microtask             | ok | ok | ok | ok\* | ok | 5/5   |
| promise-chain-drains-fully            | ok | ok | ok | ok   | ok | 5/5   |
| await-resumes-as-microtask            | ok | ok | ok | ok   | ok | 5/5   |
| queuemicrotask-orders-with-promise    | ok | ok | ok | ok   | ok | 5/5   |

**Totals: 25 pass, 0 fail, 0 err, 0 skip.**

\* nexttick-before-microtask run 4 first hit `net::ERR_CONNECTION_REFUSED`
on `localhost:5173` due to a stale Vite zombie process (PID 8883) from a
prior aborted run. Runner exited 2 (infra error), not 1 (assertion
failure). After `kill -9` the re-run passed cleanly. Recorded as the
canonical run because the failure was runner cleanup, not the test
under study.

## Failure logs

None. No stdout mismatches, no `THREW`, no non-zero exits, no `_start`
sentinel timeouts.

## Side-finds (non-blocking, but worth noting)

1. **Runner zombie on abort**: `browser-test-runner.mjs` doesn't trap
   SIGINT / uncaught throws to `killProc(viteProc)`. Aborted runs leave
   Vite bound to 5173, poisoning the next invocation. Suggest hooking
   `process.on('SIGINT', ...)` in `_runner-common.mjs`.
2. **README path clarity**: this experiment's README said `cd browser-target`
   for the runner invocation. Tests live at project-root `tests/js/`, not
   `browser-target/tests/js/`. One-line fixup if anyone reads this later.

## Recommendation

**Ship-as-is for the 5 tests in scope.** SHIPPED is solid. No hardening
or revert needed.

## What this DOESN'T cover (relevant to e27/e28)

These 5 tests probe simple ordering (one microtask, one timer). They
don't exercise within-iteration ordering (multiple due timers in one
uv_run iteration). That gap is what e27 probes — and e27 confirmed the
within-iteration ordering hole is real and worse than predicted
(silent data loss via `process.exit`-from-timer2). e28 should proceed.
