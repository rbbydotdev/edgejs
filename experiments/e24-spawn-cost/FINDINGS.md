# E24: (host+wasm) pair spawn cost + WebAssembly.Module transferable

**Date:** 2026-05-24
**Worktree (deleted):** `agent-ad30d74344d813e11` (port 5199)
**Result:** **Module sharing via postMessage works perfectly.**  Per-pair
boot drops 2× to 25-35ms steady state.  Per-pair memory is ~22 MB
(linear memory only) with code shared.  Estimated ceiling ~80-100 pairs
per tab.

## Probe shape

A minimal probe Worker that receives one of:
- **Config A** (`init-config-a`): raw wasm bytes → child compiles + instantiates
- **Config B** (`init-config-b`): pre-compiled `WebAssembly.Module` → child skips compile

The probe does NOT run `_start` (real edge boot adds 100-300 ms/pair on
top — those costs are independent of and additive with Module-sharing
savings).

`?probe=e24-spawn-cost&n=N` bypasses regular runtime spawn, pre-compiles
once on the page, spawns N pairs sequentially under each config.

## Numbers (Chromium headless, MBP, N=10 sequential)

`bootMs` = `spawnHostWorker().ready` + `new Worker(probe)` + child
compile (A only) + child instantiate + ping RTT.

| Config | Pair # | Boot (ms) | Child compile (ms) | Instantiate (ms) | Linear mem (MB) |
|--------|--------|-----------|---------------------|------------------|-----------------|
| A (per-pair compile) | 1 | 341 | 26 | 3.9 | 21.1 |
| A | 5 | 65 | 21 | 3.6 | 21.1 |
| A | 10 | 65 | 25 | 3.5 | 21.1 |
| **B (shared Module)** | **1** | **27** | **0** | **3.3** | **21.1** |
| **B** | **5** | **26** | **0** | **3.4** | **21.1** |
| **B** | **10** | **32** | **0** | **3.5** | **21.1** |

Pair #1 config A is cold-start outlier (vite + V8 JIT warmup).  Steady
state from pair #2.  Pre-compile cost on page: 19-23 ms (paid once).

## Does Module-sharing save compile time?  **YES — completely.**

`postMessage(module)` (no transfer list — Module is structured-
cloneable, not transferable in the listed sense) preserves the compiled
code on the receive side.  Verified: throwaway worker receives the
Module and `WebAssembly.Module.imports(received)` returns the expected
277 import descriptors.  Child-side `compileMs` is exactly 0 in every
config-B sample.

**Per-pair boot drops ~2× (50-65 ms → 25-35 ms steady-state).**

## Memory cost per pair

Reliable cross-realm memory measurement was **not achievable** in this
Chromium build:
- `performance.measureUserAgentSpecificMemory`: throws "not available"
  under COOP/COEP isolation
- `performance.memory.usedJSHeapSize`: page-scoped, doesn't track wasm
  linear memory or worker heaps
- CDP `Memory.getProcessMemoryInfo`: not implemented

Falling back to direct accounting of what each pair allocates:

| Component | Config A per pair | Config B per pair |
|-----------|-------------------|-------------------|
| Wasm linear memory (337 pages SAB) | 21.1 MB | 21.1 MB |
| Compiled wasm code (V8 JIT for 26 MB wasm → ~30-50 MB) | ~30-50 MB | 0 (shared) |
| Host worker (5 SABs + V8 heap) | ~1-2 MB | ~1-2 MB |
| **Total** | **~52-72 MB** | **~22-23 MB** |

## Estimated ceiling (didn't push to OOM)

- Config A: ~30-50 pairs before compiled-code duplication pressures the tab
- **Config B: ~80-100 pairs** before linear-memory dominates a ~2 GB practical tab budget

## Recommendations

- **Default pre-warmed pairs: 0.**  Spawn lazily on first user
  `worker_threads.Worker` call — 25-35 ms steady-state is comparable to
  Node's `Worker.online` (~10-30 ms native).  Pre-warming wastes ~22 MB
  SAB per unused pair.
- **Hard cap: configurable, default 16.**  Matches `os.cpus().length`-
  ish heuristic; leaves headroom under config-B ceiling; gives a clear
  error rather than silent OOM.
- **Ship the shared-Module path (config B) as MANDATORY.**  Compile
  edgejs.wasm once on main (or first runtime), postMessage the Module
  to every subsequent pair.  ~22 ms / pair compile + ~30-50 MB / pair
  code memory both disappear, for free, per spec.  **Biggest
  architectural lever the experiment surfaced.**

## Caveats

- **`postMessage(WebAssembly.Module)` worked first try.**  Most
  uncertain part of the brief — it just works.
- **Cross-realm memory measurement is broken** in every page-accessible
  route.  Future memory experiments need an OS-level tool or a
  Chromium build with origin trial flipped on.
- **`performance.now()` clamped to 1 ms** under COOP/COEP (per E12).
  3-4 ms instantiate numbers are at clock-resolution edge — read as
  "≤5 ms" not exact.
- **First-pair cold-start outlier (~340 ms in A).**  Vite serving +
  V8 JIT warmup; steady state from pair #2.
- **Probe does NOT run `_start`.**  Real edge.js boot adds another
  100-300 ms / pair (libuv + emnapi + threadpool init); Module-sharing
  savings are independent and additive.
- **Existing test suite unaffected** — `?probe=e24-spawn-cost` is
  opt-in, default flow unchanged.

## What this means for phase 1

- **Mandatory: share compiled Module via postMessage to every spawned
  runtime worker.**  Free 2× boot speedup, free per-pair memory savings.
- **Pre-warm: skip in v1.**  25-35 ms lazy spawn is acceptable.
- **Cap: 16 pairs default.**  Documented limit; clear-error semantics.

## Files in worktree (not merged)

- `browser-target/src/probe-e24-worker.ts` — minimal probe worker
- `browser-target/src/main.ts` — `?probe=e24-spawn-cost` mode
  (`runE24SpawnCostProbe`, ~lines 660-820)
- `experiments/e24-spawn-cost/run-probe.mjs` — Playwright + Vite driver
