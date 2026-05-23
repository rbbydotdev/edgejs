# Lever B — Split-worker topology + ESM/worker_threads hooks

**Status:** planning · pending research return (ESM + worker_threads + WebContainer agents).
**Tag:** `pre-lever-b` marks the starting state.
**Last updated:** 2026-05-23.

---

## Goal

Land a structurally correct runtime architecture where:

- The page main thread stays IDLE — the runtime feels like a background
  server the page talks to, not something embedded in the page.
- Microtask ordering matches Node (closes
  `microtasks-starved-by-pending-timer` and related debts).
- ESM "just works" via browser-native loader + node-builtin resolver shim
  (post-foundation; designed-for from day one).
- `worker_threads` "just works" by spawning additional host workers
  (post-foundation; designed-for from day one).
- Future optimization happens via the existing policies layer, with the
  slow-correct Lever B path as the spec each policy must match.
- Astro and Rolldown become realistic targets.

**Total scope:** 5–7 weeks foundation, +2–4 weeks for ESM and worker_threads.

---

## Mental model

> The webpage has a background server running somewhere.

```
┌──────────────────────────────────────────────────────────┐
│ Page (main thread)                                       │
│ - Bootstraps the runtime (one-time setup, ~50 LOC)       │
│ - Registers Service Worker                                │
│ - Spawns the runtime workers                              │
│ - **IDLE thereafter** — no per-request CPU on main thread │
│ - Optional UI for log/inspect; not load-bearing           │
└──────────────────────────────────────────────────────────┘
                                │
                                │ one-time spawn
                                ▼
┌──────────────────────────────────────────────────────────┐
│ Host worker (DedicatedWorker)                            │
│ - emnapi context, napi-host RPC server                   │
│ - **User JS runs here** (native V8, microtasks drain     │
│   naturally at task boundaries)                          │
│ - FS adapter (bundled + OPFS, absorbed from bridge)      │
│ - HTTP bridge (absorbed from bridge worker)              │
│ - Direct MessageChannel to Service Worker (no page hop)  │
│ - Always-responsive: never blocks on wasm Atomics.wait   │
└──────────────────────────────────────────────────────────┘
                                │ SAB-RPC
                                ▼
┌──────────────────────────────────────────────────────────┐
│ Wasm worker (DedicatedWorker)                            │
│ - edge.js wasm runtime + libuv loop                      │
│ - Edge's `lib/*` Node internals run here                 │
│ - JSPI yields for blocking I/O                           │
│ - Free to block in Atomics.wait — doesn't affect host    │
└──────────────────────────────────────────────────────────┘
                                │
                                │ wasi_thread_start (existing)
                                ▼
┌──────────────────────────────────────────────────────────┐
│ Thread workers (pool)                                     │
│ - pthread pool for libuv worker pool                     │
│ - unchanged from today                                    │
└──────────────────────────────────────────────────────────┘
```

**3 logical workers (excluding pthread pool):** page + host + wasm.

Page does **only** setup. After boot, the runtime is fully off-main-thread.
HTTP requests from the page (`fetch('/api/...')`) go through SW directly to
the host worker — no page involvement per request.

---

## Architectural commitments (lock these now)

1. **Page main thread is IDLE post-boot.** No per-request CPU on main.
   Page is ~50 LOC: SW register + spawn host worker + go quiet.
2. **Host worker is spawnable, not singleton.** All code/protocol uses
   `hostWorkerId`. Initial N=1; protocol supports N>1 for `worker_threads`.
3. **User code always runs on a host worker.** Never on wasm. `new
   Function(code)` for `-e`; `import(blob:)` for ESM later. The wasm
   worker only sees results, not source.
4. **Edge.js's own `lib/` JS stays in wasm.** Edge-internal code is
   bundled; runs through wasm. The boundary is "edge internals (wasm)"
   vs "user code + napi-host JS (host worker)".
5. **napi RPC always carries a `contextId`** field, even when N=1.
   Reserves the worker_threads dimension.
6. **Bridge worker merges into host.** Same architectural property
   (responsive JS); no reason to keep separate post-Lever-B. The original
   `jspi-re-entry-blocks-microtasks` rationale for separation goes away
   when wasm is on its own worker.
7. **Slow-correct path is the spec.** Policies remain opt-in fast paths
   that must match the slow path's semantics. Each policy declares what
   subset of Node behavior it preserves.
8. **emnapi vendored from Layer 0** with a feature flag. Default off;
   used for probing internals; switch to default-on if/when we need to
   modify.

---

## Perf budgets

Each layer ships when **tests green AND perf within budget OR debt entry
filed with explicit fix path**.

| Layer | Metric | Budget | Hard stop |
|---|---|---|---|
| L1 (sab-ring refactor) | All metrics | ±5% of current | >10% slowdown |
| L2 (host worker spawn) | Boot time | +20% over current | +40% |
| L3 (read-only napi RPC) | Per-napi call cost | <5μs RPC overhead | >10μs |
| L4 (callback RPC) | Cross-worker callback latency | <20μs end-to-end | >50μs |
| L5 (cutover) | Per-request latency | +50% over current | +100% |
| L6 (policies) | All metrics | Same as L5 | n/a |
| L7 (tests) | n/a | n/a | n/a |

**Rule:**
- <10% over budget → ship, no entry needed
- 10–30% over budget → ship + NOTES.md debt entry with concrete fix path
- \>30% over budget → blocked; revisit approach

The perf harness (Layer 0 deliverable) measures these continuously.

---

## Layer-by-layer plan

Each layer has: **Goal · Deliverables · Parallel sub-tasks · Audit
checklist · Exit criteria**.

Subagent audit rules (apply to every parallelized sub-task):
1. Read the actual `git diff` first, not the agent's summary.
2. Run `npm run test:browser` — must show same or higher pass count.
3. Check NOTES.md + `#!~debt` markers — every shortcut flagged.
4. Read inline comments for "TODO", "HACK", "FIXME".
5. Probe edge cases — empty input, max-size input, concurrent invocations.
6. Verify the layer goal is actually met end-to-end.
7. No silent test skips without NOTES.md attribution.

---

### Layer 0 — Baseline + Safety net (1–2 days)

**Goal:** Measure current state; have something to validate against.

**Deliverables:**
- Perf harness at `browser-target/scripts/browser-perf-runner.mjs` that times: boot, simple HTTP request (via SW bridge), fs read, napi call count + per-call ranges.
- Vendored emnapi at `vendor/emnapi/` (full clone) with `EDGE_USE_VENDORED_EMNAPI=true` env flag. Default OFF; for probing only.
- All 15 currently-passing tests still green at each subsequent layer.
- Baseline numbers logged into `NOTES.md` (or a new `plans/lever-b-progress.md`).

**Parallel sub-tasks** (1 agent each):
- **0a**: Build the perf harness (extend `browser-test-runner.mjs`).
- **0b**: Audit `tests/js/*.skip` — each cites the right NOTES.md debt.
- **0c**: Vendor emnapi + add the feature flag.

**Audit:**
- Perf numbers reproducible (variance <10% across 3 runs).
- Vendored emnapi compiles + tests pass with flag OFF (no behavior change).
- Test runner output unchanged from pre-Layer-0.

**Exit criteria:**
- Baseline numbers documented.
- 15 passing tests remain green.
- Vendored emnapi compiles, flag works.

---

### Layer 1 — Unified SAB-ring primitive (3–4 days)

**Goal:** One primitive `wasi-shim/sab-ring.ts` that backs all
cross-worker communication. Pure refactor; no behavior change.

**Deliverables:**
- `wasi-shim/sab-ring.ts` — atomic claim, fixed-size slots, wake counter,
  waiter/notifier, **`contextId` field in slot header** (4 bytes).
- 4 existing channels reimplemented on it:
  - `pipes-sab.ts`
  - `fs-snapshot-sab.ts`
  - HTTP bridge SAB (currently in `worker.ts`)
  - (Stub) napi RPC channel — empty placeholder.
- All existing tests pass unchanged.

**Parallel sub-tasks:**
- **Sequential first** (me, ~1 day): design the sab-ring API + write
  `sab-ring.ts` with type signatures and design rationale.
- **Then in parallel** (3 agents):
  - **1a**: Refactor `pipes-sab.ts` to use sab-ring.
  - **1b**: Refactor `fs-snapshot-sab.ts` to use sab-ring.
  - **1c**: Refactor HTTP bridge SAB to use sab-ring.

**Audit:**
- Original SAB semantics preserved (FIFO ordering, wake delivery, claim
  fairness).
- All 15 tests still pass.
- No `#!~debt` markers without NOTES.md entries.
- No silent skips of edge cases (zero-byte writes, ring-full, concurrent
  claimers).
- Perf within ±5% of baseline.

**Exit criteria:**
- 4 channels on `sab-ring.ts`. Net LOC unchanged or lower.
- All tests pass. Perf within budget.
- **Reversible**: pure refactor; revertible without lock-in.

---

### Layer 2 — Host worker abstraction (3–4 days)

**Goal:** Spawn a host worker (initially absorbing bridge's role). Define
RPC primitive. Prove with one round-trip op.

**Deliverables:**
- `browser-target/src/host-worker/` (new directory)
  - `host-worker.ts` — worker entry point.
  - `rpc-server.ts` — host side: receives requests, dispatches.
  - `rpc-client.ts` — wasm-side outbound RPC.
  - `worker-pool.ts` — manages N host workers (N=1 today).
- Lifecycle: spawn from page, ready handshake, shutdown, error handling.
- ONE proof-of-life RPC: `ping` op that round-trips.
- **Page becomes nearly idle**: SW register + spawn host + spawn wasm,
  then quiet. ~50 LOC remaining in `main.ts`.
- Bridge worker's role absorbed into host worker (FS adapter, snapshot
  loader, HTTP bridge). Delete `bridge-worker.ts`.
- Direct MessageChannel between SW and host worker (no page relay).

**Parallel sub-tasks:**
- **Sequential first** (me, ~1 day): design RPC protocol — op-code table,
  request layout, reply layout, error handling, `contextId` field.
- **Then in parallel** (2 agents):
  - **2a**: Build rpc-server.ts on host + worker spawn in main.ts +
    implement `ping`.
  - **2b**: Build rpc-client.ts on wasm side + hook into wasi-shim +
    test ping op.

**Audit:**
- Protocol matches design doc.
- `contextId` field present even though unused.
- Error paths: host crash, wasm crash, SAB exhaustion.
- Ping RTT measured (target 5–20μs).
- No protocol drift between client/server.
- Page main thread profile shows IDLE after boot (verify in Chrome
  DevTools).
- SW→host direct route works without page involvement.

**Exit criteria:**
- 3-worker topology working: page + host + wasm.
- Bridge worker deleted (responsibilities moved to host).
- `ping` RPC reliable.
- RTT documented.
- Page CPU profile: idle after boot.
- **Reversible**: host worker can be disabled via flag for emergency
  fallback.

---

### Layer 3 — napi RPC for read-only ops (4–5 days)

**Goal:** Move read-only napi ops to host. Keep in-process path live for
diff testing.

**Deliverables:**
- `EDGE_NAPI_VIA_HOST=true` build flag.
- ~30 read-only napi ops route through RPC: `napi_typeof`,
  `napi_get_*`, `napi_has_*`, `napi_is_*`, `napi_strict_equals`, ref
  counts, etc.
- napi-host factored so RPC + in-process paths share most logic.
- Diff-test harness: run a test twice (RPC + in-process); output must match.
- Updated test runner with `--lever-b` flag.

**Parallel sub-tasks:**
- **Sequential first** (me, ~1 day): design napi op-code table + handle
  serialization across the boundary.
- **Then in parallel** (2 agents):
  - **3a**: RPC server-side dispatch for read-only ops (host).
  - **3b**: RPC client-side wrapping on wasm.
- **Then me**: integration + diff testing.

**Audit:**
- Handle ID serialization consistent.
- Error paths preserved (napi_status return values match).
- No silent fallbacks (RPC failure → visible error).
- Diff test passes for all 15 active tests.
- Per-op RPC cost measured + documented.
- All 15 tests pass with `--lever-b`.

**Exit criteria:**
- Read-only napi ops working via RPC.
- Diff test passes.
- Perf within budget (<5μs per op).
- **Reversible**: in-process path still default.

---

### Layer 4 — napi RPC for callback-taking ops (5–7 days — the hard layer)

**Goal:** Bidirectional RPC for callback-taking napi ops. This is where
most architectural risk lives.

**Deliverables:**
- Reverse channel: host → wasm for callback invocation.
- `napi_call_function` works via RPC.
- `napi_create_function` returns host-side proxy; calling from wasm
  triggers host invocation.
- `napi_create_threadsafe_function` works.
- Finalizers fire correctly across the boundary.
- Promise rejection callback wired across.

**Parallel sub-tasks:**
- Mostly sequential (me) for `napi_call_function`.
- **4a** (parallel): finalizer routing across workers.

**Audit:**
- Memory safety: who owns handles during cross-worker callback?
- Finalizer ordering preserved (matches Node).
- Threadsafe function queue semantics correct.
- No silent re-entrancy bugs (host→wasm→host loops).
- All 15 tests pass with `--lever-b`.
- Subset of upstream Node corpus runs (start with handful of napi tests).
- Perf within budget (<20μs cross-worker callback).

**Exit criteria:**
- All napi ops route via RPC (when `--lever-b` enabled).
- Bidirectional callbacks work.
- Diff test still passes.
- **Reversible**: still opt-in.

---

### Layer 5 — Move emnapi context + user code to host (4–5 days) — LOCK-IN

**Goal:** Cutover. emnapi context on host worker. User code on host.
Wasm worker has emnapi only as a stub that RPCs to host.

**Deliverables:**
- emnapi `createContext` happens on host worker (may require vendored
  emnapi modification — switch on the vendor flag).
- `napi.bindInstance` happens via RPC.
- User-script execution moves to host:
  - `unofficial_napi_contextify_run_script` → routes to host.
  - Host runs `new Function(code)` in its own global scope.
- Microtask handling: user `Promise.then` callbacks queue on host's V8 →
  drain naturally at task boundaries (this CLOSES the regression).
- `unofficial_napi_process_microtasks` on host: no-op (host drains
  naturally) or explicit checkpoint at known-safe points.

**Parallel sub-tasks:**
- Mostly sequential — this is the load-bearing cutover.
- **5a** (parallel): update `microtask-ops.ts` to be host-side.
- **5b** (parallel): update `globals-shim.ts` for new context location.

**Audit:**
- Microtask test passes: `microtask-before-timer`,
  `nexttick-before-microtask`, `promise-chain-drains-fully`,
  `queuemicrotask-orders-with-promise` — un-skip and verify.
- `lazy-load-from-microtask` test passes — un-skip.
- `unhandled-rejection-fires` passes — un-skip.
- Perf delta documented (we have real numbers now).
- All 15 original tests still pass.

**Exit criteria:**
- `--lever-b` mode is the DEFAULT.
- All microtask-class regressions closed.
- Real perf delta documented; within budget (+50% per-request).
- **Lock-in point**: hard to revert past here. Confirm with user before
  flipping default.

---

### Layer 6 — Migrate policies + cleanup (2–3 days)

**Goal:** Policies that touch JS run on host. Remove in-process napi
path. Tighten codebase.

**Deliverables:**
- All `policies/*.ts` that interact with JS run on host worker.
- In-process napi path removed (no `--lever-b` flag; it's the only path).
- `__edgePromisingDepth` global + depth-tracking removed.
- NOTES.md updated: close resolved debts; document new architecture.

**Parallel sub-tasks** (3 agents):
- **6a**: Migrate crypto-host-random + outbound-fetch-tunnel policies.
- **6b**: Migrate compression-via-compressionstream + fast-readfile.
- **6c**: Clean up depth-tracking + dead in-process paths.

**Audit:**
- Each policy still does what it claims (test it).
- No commented-out code remaining.
- NOTES.md reflects current state.
- Pass count same or higher.

**Exit criteria:**
- Single code path.
- All policies functional.
- Clean codebase.

---

### Layer 7 — Test corpus expansion (2–3 days)

**Goal:** Real validation against upstream corpus. Un-skip everything
that should pass.

**Deliverables:**
- Un-skip: `microtask-before-timer`, `nexttick-before-microtask`,
  `promise-chain-drains-fully`, `queuemicrotask-orders-with-promise`,
  `unhandled-rejection-fires`, `regression-lazy-load-from-microtask`,
  `regression-microtask-not-starved`.
- New: `WebAssembly.compile().then(...)` test (the Rolldown smoke).
- C++ drop-ins: verify the 29 added pass (requires `make build`).
- Perf benchmarks: 20 representative ops tracked.

**Parallel sub-tasks** (3 agents):
- **7a**: Un-skip + verify microtask tests; fix residual issues.
- **7b**: WebAssembly.compile smoke + 5–10 Rolldown-shape micro-tests.
- **7c**: Extend perf harness with 20-op benchmark suite.

**Exit criteria:**
- 22+ tests passing (was 15).
- Documented perf comparison vs `pre-lever-b` tag.
- Public-facing "what edge.js now supports" summary.

---

## Optional / post-Lever-B layers

### Layer 8 — ESM via host loader (1–2 weeks)

**Pending research** (agent #12 currently investigating). Likely:
- Import map injection (page-side) for `node:*` specifiers.
- SW interception extends to module loading for bare specifiers.
- Top-level await + dynamic `import()` work natively.
- Astro's import graph resolves.

Plan to be detailed once research returns.

### Layer 9 — `worker_threads` via spawn-additional-host (1–2 weeks)

**Pending research** (agent #13 currently investigating). Likely:
- `worker_threads` stub → real impl backed by host-worker-pool spawn.
- MessageChannel between user workers (browser-native).
- `contextId` dimension in napi RPC actively used.

Plan to be detailed once research returns.

---

## Risk callouts

1. **emnapi vendoring forced.** If we can't make emnapi context live on a
   different worker without source changes, the flag flips on early.
   Worst case: +1 week.
2. **JSPI surprises.** The microtask drain bug is one symptom; Layer 4
   will surface re-entrancy + lifetime issues.
3. **napi perf delta worse than estimated.** Mitigation hooks: handle
   caching, op batching, keep cheap ops in-process via vendored emnapi.
4. **Astro / Rolldown specific bugs.** Layer 7 includes Rolldown smoke;
   Astro is post-Lever-B.
5. **Test corpus gaps.** 29 C++ drop-ins added but not run; needs
   `make build` to verify.

---

## Open questions

1. **emnapi vendoring**: probe + flag-off works for L0–L4, but how
   precisely does the host context need to differ from default emnapi?
   Resolved after Layer 4 surfaces concrete needs.
2. **Page→SW→host direct route**: need to verify SW can post directly to a
   DedicatedWorker via MessageChannel without page acting as relay. If
   not, page does minimal forwarding only on the request path.
3. **N>1 host worker scenarios**: do we eagerly preload host workers, or
   spawn on demand for `worker_threads`? Resolved in Layer 9.

---

## Progress tracking

This document is the plan. Per-layer progress lives in a new file
`plans/lever-b-progress.md` (TBD; created when Layer 0 starts).

NOTES.md continues to be the authoritative debt registry; new debts
filed there per project convention.

Update this plan when:
- Architectural commitments change (lock-in points hit).
- A layer's exit criteria are not met (document the gap).
- Research returns and unlocks specific decisions (esp. L8/L9).

---

## What we ARE NOT doing

- We are **not** implementing ESM until L8 (post-foundation).
- We are **not** implementing `worker_threads` until L9.
- We are **not** patching emnapi upstream — we vendor locally if needed.
- We are **not** rewriting policies — they continue to work as fast-path
  shims; Lever B is the slow-correct foundation.
- We are **not** moving edge.js's lib/* JS out of wasm — only user code.
- We are **not** changing the wasi-shim's I/O model — JSPI yields stay;
  the libuv-in-wasm model stays.
