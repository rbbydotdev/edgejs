# E23: microtask flakiness investigation — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a8139132969a71e0d` (port 5197)
**Result:** **Agent died at API connection error before completing
investigation.**  Main session re-verified the 3 target tests: they
remain FLAKY/FAILING on the wasm path.  Keeping `host=1` for all 3.

## What was investigated

3 host=1 microtask-ordering tests:
- `microtask-before-timer`
- `nexttick-before-microtask`
- `promise-chain-drains-fully`

E23 agent's harness-args modifications (removed `host=1`) were tested
in main, 3 runs each:

| Test | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `microtask-before-timer` | FAIL | FAIL | FAIL |
| `nexttick-before-microtask` | FAIL | FAIL | ok |
| `promise-chain-drains-fully` | FAIL | ok | FAIL |

**Conclusion: all 3 are unreliable on the wasm path.**  The agent's
removal of host=1 was premature (single-run optimism).

## Why these tests fail on the wasm path

Without a full investigation (the agent died), the likely root cause
is microtask-checkpoint ordering relative to `Atomics.waitAsync`.
E8 found microtasks DO drain on wasm worker but DRAINING DOES NOT
equal Node-correct ordering relative to timers and nextTicks.

Node's checkpoint ordering:
1. process.nextTick queue drains
2. Promise microtask queue drains
3. Timer / setImmediate macrotask runs

On the wasm path under JSPI:
1. `Atomics.waitAsync` resolves → microtasks drain (E8 confirmed)
2. BUT `process.nextTick` queue is wasm-driven (not host-driven), so
   its drain order vs Promise microtasks is non-deterministic
   relative to the JSPI resumption point.

Result: ordering tests that depend on specific interleaving see
different orderings on different runs.

## Recommendation

**Keep `host=1` for all 3.**  The host worker's V8 event loop
preserves Node-correct microtask ordering naturally (no JSPI suspend
fragmentation).

Restored harness-args to include `host=1` in main.

## Side note: pattern for future investigations

When an agent makes a behavior change to existing tests, ALWAYS
verify with multiple runs in main before integrating.  E23's agent
appears to have removed host=1 based on a single successful run;
3-run validation in main caught the flakiness.

## Strategic note

5 tests in the suite still require host=1:
- `microtask-before-timer`
- `nexttick-before-microtask`
- `promise-chain-drains-fully`
- `await-resumes-as-microtask`
- `queuemicrotask-orders-with-promise`

(Note: the latter 2 individually PASS on wasm path but combined
with the former 3 they may interact through shared state — left
host=1 for safety.)

E8 unblocked 2 host=1 tests (`regression-lazy-load-from-microtask`,
`regression-microtask-not-starved`) — those depend on microtask
DRAIN (which JSPI handles), not on specific ORDERING (which it
doesn't).

This split between "drain works on wasm" and "ordering doesn't"
is the actionable finding.  Tests that assert ordering against
timers/nextTicks need host=1; tests that just need microtasks to
eventually run can move to wasm path.

## No code changes shipped

Agent's worktree-only harness-args changes are NOT integrated.  The
host=1 setup for all 5 tests is preserved.

## Open

A real fix for Node-correct ordering on the wasm path would require:
- Forwarding `process.nextTick` queue drain from wasm to host on
  JSPI resumption boundaries
- OR adopting an Asyncify-style yield that fully returns control to
  the worker event loop (E8's investigation found this deadlocks
  under JSPI; would need real Asyncify, approach c from earlier
  NOTES followup #1)

Both are deferred per existing NOTES analysis.  Keeping host=1 is
the pragmatic answer.
