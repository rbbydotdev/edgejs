# internal/timers Deferral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce cold-start time by deferring the first load of `internal/timers` from line 69 (before most deps are cached) to line 232 (after `internal/async_hooks` and `internal/validators` are already cached).

**Architecture:** `lib/internal/bootstrap/node.js` currently requires `internal/timers` at line 69, before its two heaviest deps (`internal/async_hooks`, `internal/validators`) are in the module cache. `lib/timers.js` (loaded at line 232) also requires `internal/timers`. By removing the line 69 eager require and inlining the require at the point of actual use (line 361), the first load of `internal/timers` naturally moves to line 232, where the two expensive deps are already cached. This follows the same pattern that eliminated 5.8ms in Pass 3 (source_map_cache deferral).

**Tech Stack:** Node.js/Edge.js bootstrap JS (`lib/internal/bootstrap/node.js`), `lib/internal/timers.js`, `hyperfine` for measurement.

---

## File Map

| File | Change |
|---|---|
| `lib/internal/timers.js` | Temporary debug probe (Task 1 only — removed in same task) |
| `lib/internal/bootstrap/node.js` | Remove line 69 eager require; inline require at line 361 |
| `docs/startup-investigation.md` | Document Pass 5 findings and results |

---

### Task 1: Trace the load site and confirm dep cache state

**Files:**
- Modify (temporarily): `lib/internal/timers.js`

This confirms the hypothesis before changing production code. The probe is added and removed within this task.

- [ ] **Step 1: Add the debug probe at the top of `lib/internal/timers.js`**

Open `lib/internal/timers.js`. After the license comment block (around line 74, before the first `const {`), add:

```js
// TEMP DEBUG — remove before commit
process._rawDebug('=== internal/timers loaded ===');
process._rawDebug(new Error().stack);
```

- [ ] **Step 2: Rebuild**

```bash
cmake --build build-edge -j8 2>&1 | tail -5
```

Expected: build completes with no errors.

- [ ] **Step 3: Run the trace and capture output**

```bash
EDGE_STARTUP_TRACE=1 ./build-edge/edge -e "" 2>&1 | grep -A 20 "internal/timers loaded"
```

Record:
- Which function is at the top of the call stack (direct caller of `require('internal/timers')`)
- Which bootstrap phase this falls in (look for the nearest preceding `[EDGE_STARTUP_TRACE]` line)

- [ ] **Step 4: Check which deps are already cached at load time**

Replace the probe temporarily with:

```js
// TEMP DEBUG — remove before commit
process._rawDebug('=== internal/timers loaded, cache keys: ===');
const keys = Object.keys(require.cache || {});
for (let i = 0; i < keys.length; i++) {
  if (keys[i].includes('async_hooks') || keys[i].includes('validators') || keys[i].includes('util/inspect') || keys[i].includes('debuglog') || keys[i].includes('linkedlist') || keys[i].includes('priority_queue') || keys[i].includes('async_context_frame')) {
    process._rawDebug('  CACHED: ' + keys[i]);
  }
}
```

Rebuild and run:

```bash
cmake --build build-edge -j8 2>&1 | tail -3
EDGE_STARTUP_TRACE=1 ./build-edge/edge -e "" 2>&1 | grep -A 30 "internal/timers loaded"
```

**Decision gate:** If the output shows `internal/async_hooks` and `internal/validators` are already in cache, deferral would be sub-noise — stop here, document in `docs/startup-investigation.md`, and skip to Task 5 (revert doc). If they are NOT in cache (as expected from reading the source), proceed to Task 2.

- [ ] **Step 5: Remove the debug probe entirely**

Revert `lib/internal/timers.js` to its original state:

```bash
git checkout lib/internal/timers.js
```

Verify the file is clean:

```bash
git diff lib/internal/timers.js
```

Expected: no output (clean).

---

### Task 2: Implement the deferral in `lib/internal/bootstrap/node.js`

**Files:**
- Modify: `lib/internal/bootstrap/node.js` (lines 69 and ~361)

- [ ] **Step 1: Remove the eager require at line 69**

In `lib/internal/bootstrap/node.js`, find and remove this line (currently line 69):

```js
const internalTimers = require('internal/timers');
```

The file should now have no reference to `internalTimers` at the top level.

- [ ] **Step 2: Inline the require at the point of use (~line 361)**

Note: the C++ `setupTimers(processImmediate, processTimers)` wire-up stays in place and remains eager — we are only moving the `require` call, not deferring the event loop setup itself.

Find the block that currently reads (around line 357–366):

```js
  const { setupTimers } = internalBinding('timers');
  const {
    processImmediate,
    processTimers,
  } = internalTimers.getTimerCallbacks(runNextTicks);
  // Sets two per-Environment callbacks that will be run from libuv:
  // - processImmediate will be run in the callback of the per-Environment
  //   check handle.
  // - processTimers will be run in the callback of the per-Environment timer.
  setupTimers(processImmediate, processTimers);
  // Note: only after this point are the timers effective
```

Replace `internalTimers.getTimerCallbacks(runNextTicks)` with an inline require:

```js
  const { setupTimers } = internalBinding('timers');
  const {
    processImmediate,
    processTimers,
  } = require('internal/timers').getTimerCallbacks(runNextTicks);
  // Sets two per-Environment callbacks that will be run from libuv:
  // - processImmediate will be run in the callback of the per-Environment
  //   check handle.
  // - processTimers will be run in the callback of the per-Environment timer.
  setupTimers(processImmediate, processTimers);
  // Note: only after this point are the timers effective
```

- [ ] **Step 3: Verify no other references to `internalTimers` remain**

```bash
grep -n "internalTimers" lib/internal/bootstrap/node.js
```

Expected: no output. If any references remain, update them to use `require('internal/timers')` inline.

- [ ] **Step 4: Rebuild**

```bash
cmake --build build-edge -j8 2>&1 | tail -5
```

Expected: build completes with no errors.

---

### Task 3: Verify correctness with timer tests

**Files:**
- Read: `test/parallel/test-timers-api-refs.js`, `test/parallel/test-timers-clearImmediate.js`

The goal here is to confirm the event loop timer wire-up still works correctly before benchmarking.

- [ ] **Step 1: Verify setTimeout works**

```bash
./build-edge/edge -e "setTimeout(() => { process._rawDebug('timer fired'); }, 0)"
```

Expected output: `timer fired`

- [ ] **Step 2: Verify setImmediate works**

```bash
./build-edge/edge -e "setImmediate(() => { process._rawDebug('immediate fired'); })"
```

Expected output: `immediate fired`

- [ ] **Step 3: Verify the timer benchmark still produces the correct checksum**

```bash
./build-edge/edge benchmarks/workloads/timers-settimeout-chain.js
```

Expected output: `20100`

- [ ] **Step 4: Run the core timer test files directly**

```bash
./build-edge/edge test/parallel/test-timers-api-refs.js
./build-edge/edge test/parallel/test-timers-clearImmediate.js
./build-edge/edge test/parallel/test-timers-args.js
```

Expected: each exits with code 0 and no assertion errors.

- [ ] **Step 5: Run empty-startup and eval to confirm baseline still works**

```bash
./build-edge/edge -e ""
./build-edge/edge benchmarks/workloads/empty-startup.js
```

Expected: both exit with code 0 and no output (empty-startup.js has no output either).

---

### Task 4: A/B benchmark measurement

**Files:**
- None (measurement only)

Build the baseline binary before running the A/B. The baseline is the current HEAD before this change (Pass 4 state: `19bc9c14`).

- [ ] **Step 1: Copy the optimized binary**

```bash
cp ./build-edge/edge /tmp/edge-pass5-candidate
```

- [ ] **Step 2: Build the baseline binary**

```bash
git stash
cmake --build build-edge -j8 2>&1 | tail -3
cp ./build-edge/edge /tmp/edge-pass5-baseline
git stash pop
```

- [ ] **Step 3: Measure `edge -e ""`**

```bash
hyperfine --warmup 10 --runs 80 \
  "/tmp/edge-pass5-baseline -e \"\"" \
  "/tmp/edge-pass5-candidate -e \"\""
```

Record: baseline median ± σ, candidate median ± σ, delta in ms and %.

- [ ] **Step 4: Measure `edge empty-startup.js`**

```bash
hyperfine --warmup 10 --runs 80 \
  "/tmp/edge-pass5-baseline benchmarks/workloads/empty-startup.js" \
  "/tmp/edge-pass5-candidate benchmarks/workloads/empty-startup.js"
```

Record: baseline median ± σ, candidate median ± σ, delta in ms and %.

- [ ] **Step 5: Decision**

**Commit path**: both workloads show ≥1ms median improvement AND σ bands do not overlap → proceed to Task 5.

**Revert path**: delta < 0.5ms or σ bands overlap on either workload → run `git checkout lib/internal/bootstrap/node.js`, proceed to Task 5 (document as "tried and rejected").

---

### Task 5: Document Pass 5 in `docs/startup-investigation.md`

**Files:**
- Modify: `docs/startup-investigation.md`

- [ ] **Step 1: Add a Pass 5 section**

Append the following section to `docs/startup-investigation.md` (after the Pass 4 section), filling in the actual numbers from Task 4:

```markdown
## Pass 5 Investigation: internal/timers load deferral

### Hypothesis

`internal/timers` is required at line 69 of `lib/internal/bootstrap/node.js`, before
`internal/async_hooks` (loaded at line 226) and `internal/validators` (loaded at line 72)
are in the module cache. `lib/timers.js` (loaded at line 232) also requires `internal/timers`.
Removing the line 69 eager require and inlining the require at line 361 means the first load
of `internal/timers` naturally moves to line 232, where both of those deps are already cached.

### Trace findings

[Fill in: which deps were/were not cached at load time, which caller triggered the load]

### Change

- `lib/internal/bootstrap/node.js`: removed eager `require('internal/timers')` at line 69
- `lib/internal/bootstrap/node.js`: replaced `internalTimers.getTimerCallbacks(...)` with
  `require('internal/timers').getTimerCallbacks(...)` at the use site (~line 361)

### Measurement (hyperfine --warmup 10 --runs 80)

| workload | baseline (Pass 4) | Pass 5 | delta |
|---|---|---|---|
| `edge -e ""` | 35.1ms ± 0.8ms | [fill in] | [fill in] |
| `edge empty-startup.js` | 34.4ms ± 0.7ms | [fill in] | [fill in] |

### Outcome

[COMMITTED / REVERTED] — [reason: e.g. "deps were already cached, sub-noise savings" or "real win: async_hooks and validators cost removed from timers load"]

### Lesson

[Fill in based on outcome]
```

- [ ] **Step 2: Update the cumulative results table** (if committed)

If the change was committed, find the cumulative results table in `docs/startup-investigation.md` and add a Pass 5 row with the measured numbers.

---

### Task 6: Commit

**Files:**
- `lib/internal/bootstrap/node.js`
- `docs/startup-investigation.md`

Skip this task entirely if Task 4 resulted in a revert. In that case, commit only the docs update from Task 5.

- [ ] **Step 1: Stage files**

If committed:
```bash
git add lib/internal/bootstrap/node.js docs/startup-investigation.md
```

If reverted (docs only):
```bash
git add docs/startup-investigation.md
```

- [ ] **Step 2: Commit**

If committed (fill in actual numbers):
```bash
git commit -m "perf: defer internal/timers load until after async_hooks and validators are cached

internal/timers was required at line 69 of bootstrap/node.js, before its two
heaviest deps (internal/async_hooks, internal/validators) were in the module
cache. lib/timers.js (loaded at line 232) also requires internal/timers, so
removing the line 69 eager require moves the first load to line 232, where
those deps are already cached.

Measured A/B (hyperfine --warmup 10 --runs 80):
  edge -e \"\":                  35.1ms -> Xms  (-Y%)
  edge benchmarks/workloads/empty-startup.js:  34.4ms -> Xms  (-Y%)"
```

If reverted (docs only):
```bash
git commit -m "docs: document Pass 5 internal/timers deferral investigation

Traced load site, confirmed dep cache state, attempted deferral.
[One sentence summary of why no wall-clock win]"
```

- [ ] **Step 3: Verify clean state**

```bash
git status
```

Expected: `nothing to commit, working tree clean`
