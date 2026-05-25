# e27: Within-iteration ordering canary

## Hypothesis to confirm/deny

The SHIPPED fix `cf306ee4` (2026-05-24) installs `yield_for_microtasks`
at the TOP of `RunEventLoopUntilQuiescent` (BEFORE `uv_run`).  This
drains microtasks BETWEEN libuv iterations — but NOT BETWEEN individual
timers firing within a single iteration.

The 5 existing ordering tests all test simple cases (one microtask, one
timer).  They do not exercise the within-iteration case.  E23-redo's
analysis predicts the within-iteration ordering should still be wrong,
but no test in the suite probes it.

**Probe:** is the within-iteration ordering hole actually observable in
practice, or has the SHIPPED fix's 16-iteration drain pump masked it via
some side-effect we don't fully understand?

## Test design

Construct `canary.js` in this directory:

```js
// Two setTimeout(0) callbacks due in the SAME uv_run iteration.
// First timer schedules a queueMicrotask whose ordering vs the
// second timer is asserted.
//
// Node's processTimers calls runNextTicks() between timer firings
// (lib/internal/timers.js:537-538, 566-567), so on Node-correct
// behavior:
//   timer1 → microtask → timer2
//
// On the current wasm build (with kSkipTaskQueues on timer path
// and no within-iteration drain), expected:
//   timer1 → timer2 → microtask (WRONG)

const order = [];
setTimeout(() => {
  order.push('timer1');
  queueMicrotask(() => order.push('microtask'));
}, 0);
setTimeout(() => {
  order.push('timer2');
  console.log(order.join(','));
  process.exit(0);
}, 0);
```

Expected stdout (Node-correct): `timer1,microtask,timer2`
Expected stdout (current wasm, if hypothesis holds): `timer1,timer2,microtask`

## Method

1. Place test under `tests/js/e27-within-iteration-canary.js` with
   sibling `.stdout` containing the Node-correct expected output.
   (Putting it under tests/js/ lets us use the existing browser-test-runner
   without harness rewrites.  Will revert/remove if the experiment doesn't
   yield a kept fix.)
2. Run via `browser-target/scripts/browser-test-runner.mjs` × 5.
3. Record actual stdout per run.
4. ALSO run the same test under `host=1` for comparison (add a
   `.harness-args` with `host=1` temporarily).  Host should be
   Node-correct.

## Success criteria

- All 5 runs produce `timer1,timer2,microtask` → hypothesis confirmed,
  within-iteration ordering is broken, e28 becomes high-priority.
- All 5 runs produce `timer1,microtask,timer2` → hypothesis wrong,
  SHIPPED fix's drain pump somehow covers within-iteration too.
- Flake (mix of orderings) → reveals partial drain timing, still
  motivates a tighter fix.

## Cleanup

After running:
- If hypothesis confirmed: keep the test as a regression net under a
  `.skip` (with reason) until e28/e29 lands a fix.
- If hypothesis denied: remove the test file from tests/js/ (it's a
  spurious probe, not a regression net).

## Output

`FINDINGS.md` in this directory.
