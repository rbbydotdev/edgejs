# Open architectural questions — to resolve via isolated experiments

**Updated 2026-05-23 — 6 of 13 resolved.  All Tier 1+2 (L5 blockers) closed.**

## Resolved

| Q | Topic | Resolution |
|---|---|---|
| Q1 | malloc deadlock | Pre-allocated pool, host-side bookkeeping.  `experiments/l5-malloc-deadlock/` |
| Q2 | cross-worker napi roundtrip | 3 napi calls succeed end-to-end via SAB-RPC + shared memory.  `experiments/l5-real-roundtrip/` |
| Q3 | threadsafe function dispatch | emnapi v2 main-mode is exactly what L5 needs; analytical.  `experiments/l5-threadsafe-fn/` |
| Q4 | shared memory growth | No protocol needed; fresh views per call (emnapi already does this).  `experiments/memory-growth/` |
| Q5 | sync RPC edges (worker crash) | Timeout + worker.exit event detects crashes.  Ring-full + reply-full documented.  `experiments/sync-rpc-edges/` |
| Q8 | emnapi multi-context isolation | N contexts on same thread fully independent.  L9 has dual topologies.  `experiments/l9-multi-context/` |



The L5 emnapi v2 experiment (`experiments/l5-emnapi-v2/`) proved the
isolated-probe pattern works.  This file catalogs every architectural
unknown that should get the same treatment.

Convention: each question gets a dedicated `experiments/<area>-<topic>/`
directory.  Probes are JS-only or minimally-Node where possible.
Findings documented in `<dir>/FINDINGS.md`.  Main project stays clean.

## Tier 1 — Blockers (block L5 progress)

### Q1.  Malloc re-entrancy / deadlock
**Source:** experiments/l5-emnapi-v2/FINDINGS.md §"malloc re-entrancy"

When host's emnapi calls `exports.malloc()`, it RPCs to wasm.  But
wasm is BLOCKED in Atomics.wait awaiting the host's napi reply.
Deadlock.

**Candidate resolutions to test:**
- A. Pre-allocated bump pool (host allocates from a wasm-reserved region; no RPC)
- B. Wasm-side interruptible wait (drain malloc requests while in Atomics.wait)
- C. Dedicated memory worker (3rd worker owns malloc; no contention with runtime)
- D. Reverse dependency: wasm pre-allocates, passes ptrs in requests
- E. Hybrid: A by default, B as fallback

**Experiment:** `experiments/l5-malloc-deadlock/`
**Status:** TODO (next up)

### Q2.  Real wasm napi roundtrip
**Source:** L5 probe-with-memory used a STUB wasm instance.

Need to verify the pattern works with an ACTUAL wasm module that
exports napi imports as RPC stubs.  Build a tiny native addon (e.g.,
`add(a, b)` exposed via napi), call across worker boundary.

**Experiment:** `experiments/l5-real-wasm-roundtrip/`
**Status:** TODO

---

## Tier 2 — High priority (block F-2/F-3 phases of L5)

### Q3.  Threadsafe function dispatch
Wasm has a tsfn handle; needs to call the JS callback on host.  Uses
our L4 reverse channel.  Does emnapi's tsfn mechanism work when the
JS context lives on a different worker?

**Experiment:** `experiments/l5-threadsafe-fn/`
**Status:** TODO

### Q4.  Memory growth coordination
Wasm calls `memory.grow(N)` mid-execution.  Host's view of the memory
becomes stale (old `Uint8Array` references the old buffer).  How do
we keep host in sync?

**Candidate resolutions:**
- Pre-allocate max memory at boot (don't grow)
- Host re-views on every napi call (cheap?)
- Host listens for wasm grow events via SAB notify

**Experiment:** `experiments/memory-growth/`
**Status:** TODO

### Q5.  Sync RPC pattern reliability
We rely on `Atomics.wait` from host for sync RPC.  Edge cases:
- Wasm worker crashed; host waits forever?
- Reply ring full; backpressure handling?
- Timeout semantics?

**Experiment:** `experiments/sync-rpc-edges/`
**Status:** TODO

---

## Tier 3 — Medium (L7/L9)

### Q6.  Buffer-in-transferList copy detection (L9)
When user code does `worker.postMessage(buffer, [buffer])`, we need
to detect that `buffer` is wasm-aliased and copy it before transfer.
How does our code know it's wasm-aliased without edge.js internals?

**Experiment:** `experiments/l9-buffer-transfer/`
**Status:** TODO

### Q7.  Per-Worker wasm boot time (L9)
Each user `new Worker` spawns a fresh edge.js wasm.  Boot is ~150ms
per the research.  Verify this on real hardware; check if pre-warm
pool of 2-4 workers brings it to <5ms.

**Experiment:** `experiments/l9-boot-time/`
**Status:** TODO

### Q8.  emnapi multi-context isolation (L9)
Can a single host worker hold N independent emnapi contexts (one per
user Worker)?  Each must have isolated handle stores.

**Experiment:** `experiments/l9-multi-context/`
**Status:** TODO

### Q9.  RPC batching (L5 perf optimization)
L3 measured 22μs per RPC call.  Many napi sequences are correlated
(build object → set 10 properties).  Can we batch into one RPC?

**Experiment:** `experiments/l5-rpc-batching/`
**Status:** TODO

---

## Tier 4 — Lower (L8 production / cross-cutting)

### Q10. Vite node:* override (L8)
Vite externalizes `node:*` imports.  L8 spike used `virtual-fs` to
sidestep.  For production we need to disable Vite's behavior — write a
plugin or document why we can't.

**Experiment:** `experiments/l8-vite-plugin/`
**Status:** TODO

### Q11. @jspm/generator in browser worker (L8)
Can the generator run in a DedicatedWorker?  Output size?  Time to
generate for a typical package.json?

**Experiment:** `experiments/l8-jspm-generator/`
**Status:** TODO

### Q12. Worker crash recovery (cross-cutting)
A worker crashes mid-RPC.  How do we recover gracefully?  Detect via
`worker.onerror`?  Replay pending requests?  Kill the whole
runtime?

**Experiment:** `experiments/crash-recovery/`
**Status:** TODO

### Q13. COOP/COEP across subdomains (L10)
Per-project preview origin needs each subdomain to set
COOP/COEP correctly + share SAB sometimes.  Test the cross-origin
isolation story.

**Experiment:** `experiments/l10-coop-coep/`
**Status:** TODO

---

## Priority order for next session

1. **Q1 malloc deadlock** — true blocker; pick resolution
2. **Q2 real wasm roundtrip** — validate pattern with actual wasm
3. **Q4 memory growth** — critical for any non-trivial workload
4. **Q3 threadsafe fn** — needed for async work in Node lib/
5. **Q5 sync RPC edges** — robustness; can be deferred but worth nailing
6. **Q9 batching** — perf optimization; nice-to-have

Tier 3 and 4 questions can be answered as we approach those layers.

## Pattern

Each experiment:
1. Create `experiments/<area>-<topic>/`
2. Minimal package.json (vendor deps only)
3. One or more `probe-*.mjs` files with focused tests
4. `FINDINGS.md` documenting conclusions + recommendations
5. Commit; never touch main project

Once findings are settled, fold the chosen design into main project
in a separate, smaller, less-risky commit.
