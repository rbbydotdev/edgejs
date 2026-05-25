# e28: Drop kSkipTaskQueues from timer dispatch

## Hypothesis to confirm/deny

`src/edge_timers_host.cc:121` invokes `EdgeMakeCallbackWithFlags` with
`kEdgeMakeCallbackSkipTaskQueues`.  This flag has been there since the
initial code import (`aa633ef3`, 2026-05-10) — never reviewed, never
toggled, never defended in any commit message.

The flag's own header documentation at `src/edge_runtime.h:49-51` says
it "Mirrors Node's InternalCallbackScope::kSkipTaskQueues for critical
paths like HTTP parser callbacks that must not re-enter JS tick
processing."  Real Node uses `kSkipTaskQueues` for HTTP parser + stream
pipe only (per source-research agent on `node/src/`).  Real Node's
timer callback path uses `kNoFlags` and runs the full tick/microtask
drain via `InternalCallbackScope::Close` (`api/callback.cc:157,184`).

**Probe:** is the timer-path application of this flag inherited
upstream-edge.js debt that we can simply remove, or is it load-bearing
for some reason we'd discover by removing it?

## Method

1. Patch `src/edge_timers_host.cc:121`:
   - FROM: `EdgeMakeCallbackWithFlags(..., kEdgeMakeCallbackSkipTaskQueues);`
   - TO:   `EdgeMakeCallbackWithFlags(..., kEdgeMakeCallbackNone);`
2. Rebuild wasm via `./wasix/build-wasix.sh`.
3. Run the 5 ordering tests × 5 each (same as e26).
4. Run the e27 canary × 5.
5. Run the full test suite for regressions.
6. If green: keep the change in a patch file (DO NOT auto-commit; user
   reviews and decides whether to ship).
7. If red: revert source, document what broke + why.

Save the patch as `patch.diff` in this directory regardless of outcome,
so it's reproducible.

## Gating

Do not run this experiment until e26 and e27 have completed.  If e26
shows the SHIPPED fix is solid AND e27 shows no within-iteration bug,
this experiment becomes informational only (not a fix).

## Success criteria

- 5/5 ordering tests green + 5/5 canary green + no regressions → flag
  was indeed inherited debt; recommend shipping the 1-line removal.
- Ordering tests improve, regressions appear elsewhere → flag is partial
  load-bearing; analyze the regressions to scope a more surgical fix.
- No improvement → the flag wasn't the bottleneck; e29 (granularity)
  becomes the next probe.

## Output

`FINDINGS.md` + `patch.diff` in this directory.
