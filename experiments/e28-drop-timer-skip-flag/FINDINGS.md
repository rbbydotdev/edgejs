# e28: Drop kSkipTaskQueues from timer dispatch — FINDINGS

## RE-RUN (corrected: against actually-patched wasm)

### Why the original results were invalid

The first run of this experiment built the patched wasm into
`build-wasix/edgejs.wasm` but never copied it to
`browser-target/edgejs.wasm`, which is the artifact the browser
runner actually serves (via Vite at `/edgejs.wasm`; see
`browser-target/src/worker.ts:744`). The build script has no
auto-copy step. So the "patched" test pass was actually exercising
the pre-patch wasm. Before this re-run, the parent agent confirmed
the source patch (`src/edge_timers_host.cc:121` uses
`kEdgeMakeCallbackNone`), rebuilt `build-wasix/edgejs.wasm`
(May 25 15:26, md5 `c276a18ff26dda529f19eefb1f296db7`), and copied
it to `browser-target/edgejs.wasm` (same md5, same 26548564 bytes).
This re-run tested the actually-patched wasm.

### New verdict: **PARTIAL / INSUFFICIENT — same as original (but now trustworthy)**

The corrected run reproduces the original finding almost exactly.
Dropping `kEdgeMakeCallbackSkipTaskQueues` from the timer dispatch
is non-regressing on the 5 existing ordering tests but does not
deterministically fix the within-iteration microtask drop. The
canary is flaky at roughly 1-in-5 pass rate, identical failure mode
to the original (`timer1,timer2` instead of
`timer1,microtask,timer2`).

### Targeted-test table (6 tests × 5 runs, corrected run)

| Test                                  | Runs | Pass | Fail |
|---------------------------------------|------|------|------|
| microtask-before-timer                | 5    | 5    | 0    |
| nexttick-before-microtask             | 5    | 5    | 0    |
| promise-chain-drains-fully            | 5    | 5    | 0    |
| await-resumes-as-microtask            | 5    | 5    | 0    |
| queuemicrotask-orders-with-promise    | 5    | 5    | 0    |
| e28-canary-within-iteration           | 5    | 1    | 4    |

(One earlier exploratory iteration of the canary set also produced
one "err" status alongside fails. It did not recur in any
follow-up runs — likely transient infra noise, not a new failure
mode. The 5-run table above is the clean, sequential sample used
for the verdict.)

### Full-suite regression

**Not run.** Per procedure step 5: canary failed despite the
existing 5 staying green, so the full suite was skipped.

### Updated recommendation

The original recommendation stands and is now supported by a
trustworthy run:

1. The patch is safe (no regressions on the existing 5 ordering
   tests) and removes inherited debt with no defense in the
   original commit history. Real Node's timer path uses `kNoFlags`,
   so this brings us into alignment with upstream behavior.
2. The patch is **not sufficient** to fix the within-iteration
   microtask drop. A second mechanism is in play. Candidates
   to probe in a follow-up experiment (e29 or similar):
   - The JS-side timer-batch loop in edge.js may walk multiple
     expired timers within one host call without yielding a
     callback-scope close (and hence microtask drain) between
     them. The original FINDINGS already flagged this.
   - `process.exit(0)` inside `timer2` likely tears down
     synchronously before any pending microtask in the same
     iteration gets a chance to flush.

Ship-or-hold call is the user's. If shipping as inherited-debt
cleanup: safe. If trying to fix the within-iteration bug: not
enough on its own.

### Re-run state

- `src/edge_timers_host.cc:121` left patched
  (`kEdgeMakeCallbackNone`).
- `build-wasix/edgejs.wasm` and `browser-target/edgejs.wasm` left
  in their freshly-rebuilt, in-sync state.
- Canary test files (`tests/js/e28-canary-within-iteration.{js,stdout}`)
  removed.

---

## ORIGINAL (run against pre-patch wasm — invalid; kept for history)

## Verdict: **PARTIAL / INSUFFICIENT**

Dropping `kEdgeMakeCallbackSkipTaskQueues` from the timer-callback
dispatch in `src/edge_timers_host.cc:121` is **non-regressing** but
**does not by itself fix the within-iteration microtask drop**.

- All 5 existing ordering tests: still pass 5/5 with the flag removed.
- e27 canary (`timer1` queues a microtask, `timer2` exits immediately):
  4/5 fails the same way as without the patch (`timer1,timer2`),
  1/5 passes (`timer1,microtask,timer2`). The behavior is **flaky**,
  not deterministically corrected.

The flag is therefore not the sole gating mechanism for the bug. There
must be a second mechanism (likely related to `process.exit` from
`timer2` racing the microtask drain, or the way the timer batch is
walked in the JS layer) that swallows the microtask before the
callback scope can drain.

## Targeted-test table (6 tests × 5 runs)

| Test                                  | Runs | Pass | Fail |
|---------------------------------------|------|------|------|
| microtask-before-timer                | 5    | 5    | 0    |
| nexttick-before-microtask             | 5    | 5    | 0    |
| promise-chain-drains-fully            | 5    | 5    | 0    |
| await-resumes-as-microtask            | 5    | 5    | 0    |
| queuemicrotask-orders-with-promise    | 5    | 5    | 0    |
| e28-canary-within-iteration           | 5    | 1    | 4    |

## Full-suite regression

**Not run.** Per procedure step 6: canary failed despite existing 5
staying green, so full suite was skipped.

## Canary failure detail

Repeating output across the 4 failed runs (verbatim):

```
expected:
timer1,microtask,timer2
---
actual:
timer1,timer2
```

The microtask queued inside `timer1`'s callback is dropped before
`timer2` runs `console.log` + `process.exit(0)`. One run out of five
emits the correct order — the difference is timing-sensitive (likely
whether the JS-side timer list walk yields between `timer1` and
`timer2`, giving the host time to close the callback scope and drain
microtasks).

## Patch contents

See `patch.diff`. Single line: `src/edge_timers_host.cc:121`
`kEdgeMakeCallbackSkipTaskQueues` → `kEdgeMakeCallbackNone`.

## Main state

`src/edge_timers_host.cc` is **left patched** (per procedure step 8).
Wasm artifact `build-wasix/edgejs.wasm` is rebuilt against the patched
source. Canary test files were removed from `tests/js/`.

## Recommendation

**Keep the patch, but it's not the full fix.** Two reasons to retain:

1. The flag is inherited debt with no defense in the original commit
   message and no behavior justifying it for timers (Node's own timer
   path uses `kNoFlags`).
2. Removing it doesn't break anything (5/5 on all existing ordering
   tests + 1/5 on the harder canary — a strict improvement over the
   100% failure rate without it).

But the within-iteration drop is still happening 80% of the time, so
**e29 must follow** to identify the second mechanism. Candidates worth
probing:

- The timer-batch JS loop (in `lib/internal/timers.js` or equivalent
  inside edge.js) may walk multiple expired timers within one host
  call without yielding to a callback-scope close in between.
- `process.exit(0)` from `timer2` likely fires synchronously and tears
  down before any pending microtask gets a chance to flush.

If the user wants this fix shipped on its own as inherited-debt
cleanup, it's safe to do so. If the user wants the within-iteration
bug fixed, this patch alone is insufficient and the next experiment
must dig into the timer-batch loop or `process.exit` teardown order.

## Note re: TaskUpdate

`TaskUpdate` is not in my available toolset. The parent agent should
mark task #3 completed.
