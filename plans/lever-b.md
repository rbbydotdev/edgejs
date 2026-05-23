# Lever B — Split-worker architecture for browser-target

**Status:** planning complete; ready to execute.
**Baseline tag:** `pre-lever-b` (commit `1456b4eb`).
**Research:** `plans/research/{webcontainer,esm,worker-threads}-findings.md`.
**Last updated:** 2026-05-23.

---

## The big picture

Edge.js's value proposition is **Node-honest semantics by running Node's
real `lib/*.js` code as the spec**. Lever B keeps that. What changes:

> Where Node's JS *runs*. Today: inside the wasm worker's V8.
> After Lever B: on the host worker's native browser V8.

Edge.js's wasm becomes a kernel: libuv loop, syscalls, OpenSSL, the parts
of Node that have to be real C/C++. Everything that's JavaScript — Node's
`lib/*.js` AND user code — runs on the browser's native V8, on a separate
worker. This is the WebContainer architecture pattern, with edge.js's
real-Node substance instead of WebContainer's re-shimmed Node surface.

Why this is the right move:

- **WebContainer proved the pattern works** in production for 7 years across all major frameworks (Astro, Next, Vite, Vue).
- **It collapses the microtask drain bug** — user JS runs on host V8 with normal event-loop semantics. The JSPI suspend constraint that blocks today's microtask drain stops applying to user-visible code.
- **It enables ESM via native browser loader** — no asyncify-bridges needed for `import()`.
- **It enables `worker_threads`** as additional host+wasm pairs without sharing-wasm contortions.
- **It keeps edge.js's correctness advantage** — Node's actual `lib/*.js` is still the source of truth; we don't reimplement.
- **Performance**: pure JS code runs at native speed; only Node API surface pays cross-worker tax. Per workload analysis, ~5–30% slowdown for typical Node apps, optimizable via policies + napi batching.

Cost: 6–8 weeks foundation, 3–5 weeks for ESM + worker_threads.

---

## Mental model

> The webpage has a background Node server running in workers.

```
┌──────────────────────────────────────────────────────────┐
│ Page (main thread)                                       │
│ - One-time setup: register SW, spawn host + wasm workers │
│ - Spawn registry for worker_threads (Safari workaround)   │
│ - IDLE thereafter; no per-request CPU                     │
└──────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
┌───────▼────────┐  ┌───────▼───────────┐  ┌─────▼────────────┐
│ Bridge worker  │  │ Host worker(s)    │  │ Wasm worker(s)   │
│ - FS adapter   │  │ - emnapi context  │  │ - libuv loop     │
│ - SW outbound  │  │ - napi-host RPC   │  │ - syscalls       │
│ - OPFS         │  │ - User JS         │  │ - OpenSSL        │
│ - Cross-thread │  │ - Node's lib/*.js │  │ - Edge.js's      │
│   SAB FS       │  │ - Microtasks      │  │   kernel-shaped  │
│                │  │   drain naturally │  │   code           │
└────────────────┘  └───────────────────┘  └──────────────────┘
                            │                    │
                            └────── SAB-RPC ─────┘
                            │
                            │  wasi_thread_start (pthread pool inside wasm)
                            ▼
                    Thread workers (existing)
```

- **Page**: ~50 LOC; setup + spawn registry + go quiet
- **Bridge worker**: stays as today; shared across all host workers for FS/SW
- **Host worker** (N=1 today; N>1 for worker_threads): native V8 runs user JS + Node's lib/* JS + napi-host
- **Wasm worker** (one per host worker): edge.js's kernel — libuv, syscalls, OpenSSL
- **Thread workers**: existing pthread pool inside each wasm worker

For `worker_threads`, each user Worker becomes a NEW (host + wasm) pair.
Bridge stays shared.

---

## Architectural commitments (locked)

1. **Page idle post-boot.** No per-request CPU on main. Spawns Workers (because Safari nested-Worker is unreliable); spawning is microseconds.
2. **User JS + Node's lib/*.js runs on the host worker's native V8.** Not in wasm. This is the load-bearing decision.
3. **Wasm worker is kernel-shaped.** libuv, syscalls, OpenSSL — the C/C++ parts of Node that must remain. NO user-facing JS execution.
4. **Bridge worker stays as today**, shared across all host workers. Absorbs no new responsibilities in Lever B.
5. **napi RPC always carries `hostWorkerId` + `contextId`** fields, even when both are 0. Reserves the dimensions for worker_threads.
6. **`node:*` prefix mandatory** for user imports starting v1. Match Deno + Cloudflare posture.
7. **Per-Worker wasm** (not shared) for `worker_threads`. WebContainer's pattern; Node's process-state isolation requires it.
8. **Per-project preview origin** for SW scope isolation (when `listen()` previews ship publicly). Can be same-origin in dev.
9. **`process.arch = 'wasm'`, `process.platform = 'browser'`** — be honest. WebContainer's `'x64 linux'` lie broke napi-rs distribution. Don't repeat.
10. **emnapi vendored from L0** (flag-off); switch on if we need to modify.
11. **No native `.node` addons**, ever. Mandate wasm equivalents (emnapi). Same constraint WebContainer accepts.
12. **No FS persistence by default**; OPFS is opt-in.
13. **Slow-correct is the spec.** Policies are opt-in fast paths that must match the slow path's semantics.

---

## Perf budgets

Each layer ships when **tests green AND perf within budget OR debt entry
filed with explicit fix path**.

| Layer | Metric | Budget | Hard stop |
|---|---|---|---|
| L1 (sab-ring refactor) | All metrics | ±5% of current | >10% slowdown |
| L2 (host worker spawn) | Boot time | +20% | +40% |
| L3 (read-only napi RPC) | Per-napi call cost | <5μs RPC overhead | >10μs |
| L4 (callback RPC) | Cross-worker callback | <20μs RTT | >50μs |
| L5 (host V8 cutover) | Per-request latency | +50% | +100% |
| L6 (policies + cleanup) | All metrics | Same as L5 | n/a |
| L7 (tests) | n/a | n/a | n/a |

**Rules:**
- <10% over budget → ship, no entry needed
- 10–30% over budget → ship + NOTES.md debt entry with concrete fix path
- \>30% over budget → blocked; revisit approach

The perf harness (L0 deliverable) measures continuously.

---

## Layer-by-layer plan

Subagent audit rules (apply to every parallelized sub-task):
1. Read the actual `git diff` first, not the agent's summary.
2. Run `npm run test:browser` — same or higher pass count.
3. Check NOTES.md + `#!~debt` markers — every shortcut flagged.
4. Read inline comments for "TODO", "HACK", "FIXME".
5. Probe edge cases — empty input, max-size input, concurrent invocations.
6. Verify the layer goal end-to-end.
7. No silent test skips without NOTES.md attribution.

---

### Layer 0 — Baseline + safety net (1–2 days)

**Goal:** Measure current state. Vendor emnapi locally (flag-off).

**Deliverables:**
- Perf harness `browser-target/scripts/browser-perf-runner.mjs`: boot time, simple HTTP request through SW, fs read, napi call counts/ranges.
- Baseline numbers logged into `plans/lever-b-progress.md` (new file).
- Vendored emnapi at `vendor/emnapi/` with `EDGE_USE_VENDORED_EMNAPI=true` env flag; default OFF.

**Parallel sub-tasks** (3 agents):
- **0a**: Build perf harness (extend `browser-test-runner.mjs`)
- **0b**: Audit `tests/js/*.skip` — each cites the right NOTES.md debt
- **0c**: Vendor emnapi + add feature flag

**Audit:**
- Perf numbers reproducible (variance <10% across 3 runs)
- Vendored emnapi compiles with flag OFF; tests pass unchanged

**Exit criteria:**
- Baseline numbers documented
- 15 passing tests remain green
- Vendored emnapi compiles, flag works

---

### Layer 1 — Unified SAB-ring primitive (3–4 days)

**Goal:** One primitive backing all cross-worker communication. Pure refactor; no behavior change.

**Deliverables:**
- `wasi-shim/sab-ring.ts` — atomic claim, fixed-size slots, wake counter, waiter/notifier, **`hostWorkerId` + `contextId` slot header fields** (8 bytes).
- 4 channels reimplemented on it:
  - `pipes-sab.ts`
  - `fs-snapshot-sab.ts`
  - HTTP bridge SAB (in `worker.ts`)
  - (Stub) napi RPC channel — empty placeholder
- All existing tests pass unchanged

**Parallel sub-tasks:**
- **Sequential first** (me, 1 day): design sab-ring API + write `sab-ring.ts` with type signatures + design rationale
- **Then in parallel** (3 agents):
  - **1a**: Refactor `pipes-sab.ts` to sab-ring
  - **1b**: Refactor `fs-snapshot-sab.ts` to sab-ring
  - **1c**: Refactor HTTP bridge SAB to sab-ring

**Audit:**
- Original SAB semantics preserved (FIFO, wake delivery, claim fairness)
- All 15 tests still pass
- Perf within ±5% of baseline
- No silent edge-case skips

**Exit criteria:**
- 4 channels on `sab-ring.ts`. Net LOC unchanged or lower
- Perf within budget
- **Reversible**: pure refactor

---

### Layer 2 — Host worker abstraction + RPC primitive (3–4 days)

**Goal:** Spawn a host worker. Prove with one round-trip op.

**Deliverables:**
- `browser-target/src/host-worker/`:
  - `host-worker.ts` — worker entry
  - `rpc-server.ts` — host-side dispatch
  - `rpc-client.ts` — wasm-side outbound
  - `worker-pool.ts` — manages N host workers (N=1 today)
- Page spawns host worker alongside existing bridge + wasm
- ONE proof-of-life RPC: `ping` op
- Bridge worker stays as-is (shared FS/SW infra)
- `main.ts` slim to ~50 LOC

**Parallel sub-tasks:**
- **Sequential first** (me, 1 day): design RPC protocol — op-code table, request/reply layout, error handling, `hostWorkerId` + `contextId` field
- **Then in parallel** (2 agents):
  - **2a**: rpc-server.ts on host + worker spawn in main.ts + implement ping
  - **2b**: rpc-client.ts on wasm side + hook into wasi-shim + test ping

**Audit:**
- Protocol matches design doc
- Both context-id fields present (even though unused)
- Error paths: host crash, wasm crash, SAB exhaustion
- Ping RTT measured (target 5–20μs)
- Page CPU profile shows IDLE post-boot

**Exit criteria:**
- 4 workers running: page + bridge + host + wasm
- `ping` RPC reliable; RTT documented
- Page idle after boot (verify in Chrome DevTools)
- **Reversible**: host worker can be disabled by flag

---

### Layer 3 — napi RPC for read-only ops (4–5 days)

**Goal:** Move read-only napi ops to host. In-process path live for diff testing.

**Deliverables:**
- `EDGE_NAPI_VIA_HOST=true` build flag
- ~30 read-only napi ops route through RPC: `napi_typeof`, `napi_get_*`, `napi_has_*`, `napi_is_*`, `napi_strict_equals`, ref counts
- napi-host factored so RPC + in-process share most logic
- Diff-test harness: run a test twice; outputs must match
- `--lever-b` flag in test runner

**Parallel sub-tasks:**
- **Sequential first** (me, 1 day): design napi op-code table + handle serialization
- **Then in parallel** (2 agents):
  - **3a**: RPC server dispatch (host) for read-only ops
  - **3b**: RPC client wrap (wasm) — intercept in napi-host/index.ts
- **Then me**: integration + diff testing

**Audit:**
- Handle ID serialization consistent
- napi_status return values preserved
- No silent fallbacks (RPC failure → visible error)
- Diff test passes for all 15 tests
- Per-op RPC cost measured + documented

**Exit criteria:**
- Read-only napi ops working via RPC
- Diff test passes; perf <5μs/op
- **Reversible**: in-process path still default

---

### Layer 4 — napi RPC for callback-taking ops (5–7 days, hardest layer)

**Goal:** Bidirectional RPC. Threadsafe functions, finalizers, `napi_call_function`.

**Deliverables:**
- Reverse channel: host → wasm for callback invocation
- `napi_call_function` works via RPC
- `napi_create_function` returns host-side proxy
- `napi_create_threadsafe_function` works
- Finalizers fire correctly across boundary
- Promise rejection callback wired across

**Parallel sub-tasks:**
- Mostly sequential (me) for `napi_call_function`
- **4a** (parallel): finalizer routing across workers

**Audit:**
- Memory safety: handle ownership during cross-worker callback
- Finalizer ordering matches Node
- Threadsafe function queue semantics correct
- No silent re-entrancy bugs (host→wasm→host loops)
- Subset of upstream napi tests pass
- Cross-worker callback RTT <20μs

**Exit criteria:**
- All napi ops route via RPC with `--lever-b`
- Bidirectional callbacks work
- Diff test still passes
- **Reversible**: still opt-in

---

### Layer 5 — Host V8 cutover (5–7 days) — LOCK-IN POINT

**Goal:** User JS + Node's lib/*.js run on host worker's native V8.
Microtask drain bug closes naturally.

**Deliverables:**
- emnapi `createContext` happens on host worker (may need vendored emnapi mod — switch on the flag if so)
- `napi.bindInstance` happens via RPC: instance is on wasm; metadata on host
- User-script execution moves entirely to host:
  - `unofficial_napi_contextify_run_script` runs on host
  - `new Function(code)` evaluates user JS on host's V8
- Node's `lib/*.js` source delivery to host:
  - **Option A (initial)**: wasm sends source on-demand to host via RPC; host caches per-module; evaluates on host V8
  - **Option B (post-Layer-5 optimization)**: pre-bundle Node's lib/*.js into host worker bundle at build time; wasm only delivers code that's missing
  - Start with A; benchmark; promote to B if needed
- Microtask handling: user `Promise.then` callbacks queue on host's V8 → drain naturally at task boundaries
- `unofficial_napi_process_microtasks` on host becomes a no-op or explicit checkpoint at known-safe points

**Parallel sub-tasks:**
- Mostly sequential — load-bearing cutover
- **5a** (parallel): update `microtask-ops.ts` to be host-side
- **5b** (parallel): update `globals-shim.ts` for new context location

**Audit:**
- Microtask tests pass (un-skip): `microtask-before-timer`, `nexttick-before-microtask`, `promise-chain-drains-fully`, `queuemicrotask-orders-with-promise`
- `lazy-load-from-microtask` test passes — un-skip
- `unhandled-rejection-fires` passes — un-skip
- `regression-microtask-not-starved` passes — un-skip
- Per-request latency measured; documented; within budget (+50% max)
- All 15 original tests still pass

**Exit criteria:**
- `--lever-b` mode is the DEFAULT (in-process path archived but not yet removed)
- All microtask-class regressions closed
- Real perf delta documented; within budget OR debt entry filed
- **Lock-in point**: hard to revert past here. Confirm with user before flipping default.

---

### Layer 6 — Migrate policies + cleanup (3–4 days)

**Goal:** Policies that touch JS run on host. Remove in-process napi path.

**Deliverables:**
- All `policies/*.ts` interacting with JS run on host worker
- In-process napi path removed (no `--lever-b` flag; it's the only path)
- `__edgePromisingDepth` global + depth-tracking removed
- NOTES.md updated: close resolved debts, document new architecture
- ARCHITECTURE.md updated
- Bridge worker stays separate (per L5 commitment)

**Parallel sub-tasks** (3 agents):
- **6a**: Migrate `crypto-host-random` + `outbound-fetch-tunnel` policies
- **6b**: Migrate `compression-via-compressionstream` + `fast-readfile`
- **6c**: Clean up depth-tracking + dead in-process paths + JSPI guard code

**Audit:**
- Each policy still does what it claims
- No commented-out code remaining
- NOTES.md reflects current state
- Pass count same or higher

**Exit criteria:**
- Single code path
- All policies functional
- Clean codebase

---

### Layer 7 — Test corpus expansion (3–4 days)

**Goal:** Real validation against upstream Node corpus.

**Deliverables:**
- Un-skip: the 4 microtask ordering tests, `unhandled-rejection-fires`, `regression-lazy-load-from-microtask`, `regression-microtask-not-starved`
- New: `WebAssembly.compile().then(...)` test (Rolldown smoke)
- C++ drop-ins: verify the 29 added pass (requires `make build` of native edge)
- Perf benchmarks: 20 representative ops tracked
- `process.arch = 'wasm'` reflected in tests

**Parallel sub-tasks** (3 agents):
- **7a**: Un-skip + verify microtask tests; fix residuals
- **7b**: WebAssembly.compile smoke + 5–10 Rolldown-shape micro-tests
- **7c**: Extend perf harness with 20-op benchmark suite

**Exit criteria:**
- 22+ tests passing (was 15)
- Documented perf comparison vs `pre-lever-b` tag
- Public-facing "what edge.js now supports" summary in README or docs/

---

## Post-foundation layers

### Layer 8 — ESM via host loader (1–2 weeks)

**Goal:** User can `import 'node:fs'`, `import './foo.mjs'`, dynamic `import()` — natively. Astro's import graph resolves.

**Strategy** (per research/esm-findings.md):
- **Native import maps** for `node:*` and bare specifier resolution (now Baseline)
- **es-module-shims polyfill mode** for features not quite Baseline (multiple maps, source/fetch hooks for virtual modules, TS type-stripping)
- **Service Worker fetch interceptor** for `/_edge/node-builtin/*` synthesized responses + late-discovered deps
- **`@jspm/generator`** for the full Node 24 module resolution algorithm (run on host worker at boot)

**Deliverables:**
- Import map injection into page HTML (via main.ts or static `<script type="importmap">`)
- es-module-shims wired into host worker bundle
- `@jspm/generator` integration (~80 KB gzipped) — generates map for user's package.json
- Service Worker handler for `/_edge/node-builtin/*` — synthesizes ESM responses for `node:*` modules backed by the napi-host bridge
- `policies/esm.ts` — opt-in, default off in v1; default on once stable
- `node:*` prefix mandatory in v1; bare specifiers handled via JSPM-generated map

**Cost:** ~1500–1800 LOC + dep additions

**Validation:** 3-day spike before committing to architecture:
1. Day 1: smoke fixture with `<script type="importmap">` mapping `node:fs` to virtual module; confirm across Chrome/Firefox/Safari
2. Day 2: add es-module-shims + JSPM generator; confirm React + 2 transitive deps resolve
3. Day 3: add SW interception; confirm host worker imports synthesized fs; confirm dynamic `import()`; confirm cross-worker IPC to napi-host

**Fallbacks (if 3-day spike fails):**
- **Plan B**: dynamic-only `await edgeRequire('node:fs')` — ~200 LOC; ugly UX but works
- **Plan C**: require bundle step (Vite/Rolldown) before deploy; punts to bundler ecosystem

**Don't:**
- Use blob: URLs for user code (relative imports fail in non-hierarchical schemes)
- Share one import map across host + wasm — separate maps for separate "environments"
- Rely on `import()` inside Service Worker handler (still spec-unresolved)
- Re-implement Node's resolver — use JSPM generator or let lib/* do it

---

### Layer 9 — `worker_threads` via per-Worker host+wasm (1–2 weeks)

**Goal:** `new Worker(filename)` from user code spawns a real Node-style Worker.

**Strategy** (per research/worker-threads-findings.md):
- **Per-Worker wasm**: each user Worker = new (host + wasm) pair. WebContainer's pattern. Shared wasm cannot deliver Node's process-state isolation.
- **Bridge worker shared** across all host workers — FS, SW infrastructure unchanged
- **MessagePort** allocated on page; ports transferred to child workers
- **Buffer in `transferList` MUST be copied** to plain ArrayBuffer (wasm-aliased SAB can't be transferred)
- **Sync spawn semantic**: buffer parent→child messages until child's `'online'` (same trick WebContainer uses)
- **Bridge worker needs `release-by-owner`** plumbing — `worker.terminate()` must free FS slots/sockets the dead Worker owned

**Deliverables:**
- `browser-target/src/node-worker.ts` — Worker entry (cloned from worker.ts, ~250 LOC)
- `browser-target/src/host/node-worker-host.ts` — MessageChannel routing (~300 LOC)
- `policies/worker-threads-via-host.ts` — lib override (~250 LOC)
- `main.ts` spawn handler (Safari nested-Worker workaround, ~50 LOC)
- Buffer→ArrayBuffer copy on transfer (~30 LOC)
- Bridge worker `release-by-owner` op (~80 LOC)
- 15 must-preserve test scenarios (per research/worker-threads-findings.md), implemented

**Cost:** ~1100 LOC + ~300 LOC tests

**Skip in v1:**
- `resourceLimits.maxOldGenerationSizeMb`, `getHeapSnapshot`, CPU profile, inspector
- `process.chdir`/`setuid` in worker — throw `ERR_WORKER_UNSUPPORTED_OPERATION`
- Stdio piping (`stdin`/`stdout`/`stdout` Worker options) — defer to v2

**Don't:**
- Conflate with emnapi's wasi-threads (that's C-level pthread; different model)
- Try shared wasm + multiplexed Workers — Node's process-state isolation requires real per-Worker isolates
- Promise FS persistence per Worker — share bridge's ephemeral FS

---

### Layer 10 — Per-project preview origin (3–5 days; optional)

**Goal:** Multi-project HTTP `listen()` previews via SW scope isolation.

**Strategy:** WebContainer's per-project subdomain pattern. Each running
edge.js project gets its own `<project-id>.<base>.example.com` origin.
The SW registered on that origin intercepts all fetch traffic to the
project. Allows iframe-src previews without scope collisions.

**Defer if not needed for current use case.** Same-origin works for v1.

---

## Risk callouts

1. **emnapi vendoring becomes mandatory.** L5 might force the flag on. Worst case +1 week.
2. **JSPI surprises in L4.** Re-entrancy, lifetime issues. Time-boxed: if blocked >3 days, escalate.
3. **napi perf delta worse than estimated.** Mitigation hooks: handle caching, op batching, vendored emnapi for cheap in-process ops.
4. **Astro / Rolldown specific bugs.** L7 includes Rolldown smoke; Astro is post-L9.
5. **Node lib/*.js coupling to wasm V8 internals.** Some `lib/internal/*` may use V8-specifics not available on browser V8. Surfacing in L5; fixes scoped per-issue.
6. **Test corpus gaps.** 29 C++ drop-ins added but not run; needs `make build` to verify. Can defer to L7.
7. **L8 ESM spike might fail.** Fallback plans documented above.

---

## What we are NOT doing

- We are **not** implementing ESM until L8 (post-foundation)
- We are **not** implementing `worker_threads` until L9
- We are **not** changing wasi-shim's I/O model — JSPI yields stay; libuv-in-wasm stays
- We are **not** rewriting policies — they continue as fast-path shims
- We are **not** patching emnapi upstream — vendor locally if needed
- We are **not** trying to support `.node` native addons. Ever.
- We are **not** promising FS persistence by default; OPFS is opt-in
- We are **not** lying about `process.platform` / `process.arch`

---

## Progress tracking

- This file = the plan
- `plans/lever-b-progress.md` (created in L0) = per-layer progress log
- `NOTES.md` = debt registry (continue using existing convention)
- `plans/research/*.md` = research summaries for future reference

Update this plan when:
- Architectural commitments change
- A layer's exit criteria are not met (document the gap)
- New research significantly changes a layer's strategy

---

## Open questions for review

1. **Bridge worker stays separate or merges into host?** Plan says stays separate (matches WebContainer's shared-network-adapter pattern). Confirm.
2. **L5 Option A (lazy lib/* delivery) vs Option B (pre-bundle)** — start with A; promote to B if perf demands. Confirm.
3. **L8 timing**: spike before or after L7? Recommendation: spike during L7 in parallel (3 days), commit after.
4. **L10 needed for v1 deployment**? If multi-project previews aren't a v1 requirement, skip.

---

## Key references

- `plans/research/webcontainer-findings.md`
- `plans/research/esm-findings.md`
- `plans/research/worker-threads-findings.md`
- `NOTES.md` — current debt registry
- `ARCHITECTURE.md` — current architecture (will be updated in L6)
- `pre-lever-b` tag — starting point
