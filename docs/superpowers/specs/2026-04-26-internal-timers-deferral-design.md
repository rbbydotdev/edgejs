# Design: `internal/timers` Deferral Investigation

**Date:** 2026-04-26
**Branch:** startup-investigation
**Author:** Sonu Kapoor

## Context

After Pass 3 of the Edge.js startup investigation, cold-start time sits at:

- `edge -e ""`: 35.1ms ± 0.8ms
- `edge empty-startup.js`: 34.4ms ± 0.7ms

JS lazy-load wins are largely exhausted. The remaining named JS phases are:

| Phase | Cost |
|---|---|
| `bootstrap.realm` | ~3.0ms |
| `bootstrap.node.top-level.require-internal-timers` | ~2.9ms |
| `bootstrap.per_context.primordials` | ~2.6ms |
| `bootstrap.switch.thread` | ~2.1ms |
| `bootstrap.node.fatal-exception-hooks` | ~1.4ms |
| `bootstrap.web.exposed-wildcard` | ~1.3ms |

`internal/timers` is the second-largest named JS phase at ~2.9ms and has not been traced or investigated directly. It is the highest-value remaining target before reaching structurally unavoidable phases (realm, primordials, thread switch).

## Goal

Determine whether `internal/timers` can be deferred on the `-e ""` and `empty-startup.js` paths, and if so, whether deferral produces a real wall-clock win.

## Investigation Approach

### Step 1: Trace the load site

Add a temporary stack trace at the top of `lib/internal/timers.js`:

```js
process._rawDebug(new Error().stack);
```

Run `EDGE_STARTUP_TRACE=1 ./build-edge/edge -e ""` and capture the output.

This identifies:
- Which bootstrap phase loads `internal/timers`
- Whether the load is direct or transitive
- What is on the call stack at load time

### Step 2: Check module cache state at load time

At the same point, check `require.cache` or inject a `process._rawDebug` listing of loaded modules to determine whether `internal/timers`' own dependencies are already cached.

**Decision gate**: If deps are already cached at load time, deferring `internal/timers` would produce sub-noise savings (same outcome as the Pass 4 `source_map_cache` residual investigation). In that case, skip to revert path.

### Step 3: Check C++ wire-up requirement

`internal/timers` wires up a C++ callback for the libuv timer phase. Verify whether:

- (a) The wire-up happens on the C++ side independently of the JS module, **or**
- (b) The wire-up is performed inside `lib/internal/timers.js` and must fire before the event loop starts

If (b), the wire-up call must remain eager even if the userland API surface is deferred. The lazy-load would cover only the API layer in that case.

## Lazy-Load Implementation (if trace supports it)

File: `lib/internal/bootstrap/node.js`

Replace the eager require:

```js
// Before
const { setTimeout, setInterval, ... } = require('internal/timers');
```

With a lazy getter pattern (same as source_map_cache in Pass 3):

```js
// After
let _timers;
function getTimers() {
  return _timers ??= require('internal/timers');
}
// expose timer globals via lazy getters on globalThis or process
```

The getter fires only when a timer API is first accessed. For `-e ""` and `empty-startup.js`, no timer API is ever called, so the module load is skipped entirely on those paths.

## Measurement Protocol

Build two binaries: baseline (current `startup-investigation` HEAD) and optimized (with deferral applied).

```bash
hyperfine --warmup 10 --runs 80 \
  "./build-edge-baseline/edge -e \"\"" \
  "./build-edge/edge -e \"\""

hyperfine --warmup 10 --runs 80 \
  "./build-edge-baseline/edge benchmarks/workloads/empty-startup.js" \
  "./build-edge/edge benchmarks/workloads/empty-startup.js"
```

## Decision Criteria

### Commit path

- Wall-clock median drops ≥1ms on both workloads
- σ bands do not overlap between baseline and optimized
- `node test/` passes (no timer regression)
- Commit, add to cumulative results table in `docs/startup-investigation.md`

### Revert path

- Median difference < 0.5ms or σ bands overlap
- Revert the JS change
- Document in `docs/startup-investigation.md` as a "tried and rejected" entry
- Move to Option B: `pre_execution` path splitting

## Success Criteria

A confirmed ≥1ms wall-clock reduction on both measured paths, with the mechanism documented (which load was eliminated, why the deps were uncached at that point).

## Out of Scope

- `internal/timers` behavior for scripts that actually use timers (no regression allowed, but no optimization targeted there)
- Snapshot pipeline (separate future investigation)
- `pre_execution` path splitting (Option B, separate pass)
- Any change to C++ timer infrastructure
