# e26: Verify current ground truth on 5 ordering tests

## Hypothesis to confirm/deny

The SHIPPED commit `cf306ee4` (2026-05-24) claimed 3/3 stable runs on the
wasm path for 5 microtask-ordering tests previously routed via `host=1`.
The `.harness-args` files were deleted as part of that commit.  The
conversation-context I started from claimed they were "still routed via
host=1," which contradicts current code.

**Probe:** are these 5 tests actually stable today?

## Tests in scope

- `tests/js/microtask-before-timer.js`
- `tests/js/nexttick-before-microtask.js`
- `tests/js/promise-chain-drains-fully.js`
- `tests/js/await-resumes-as-microtask.js`
- `tests/js/queuemicrotask-orders-with-promise.js`

## Method

Run each test 5 times via `browser-target/scripts/browser-test-runner.mjs`
on the current built wasm artifact (no rebuild).  Record pass/fail per
run.  Do NOT modify any source files.

Useful command (single-test filter):
```
cd browser-target
node scripts/browser-test-runner.mjs microtask-before-timer
```

The runner filters by substring; pass each test stem in turn.

## Success criteria

- 25/25 (5×5) → SHIPPED is solid, document and close.
- 24/25 or below → flake confirmed, e28/e29 become urgent.
- A specific test consistently failing → root-cause that test.

## Output

`FINDINGS.md` in this directory with:
- Total pass/fail counts per test
- Any failure logs verbatim
- Recommendation: ship-as-is, harden, or revert
