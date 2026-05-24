# E7: scope discipline observation — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a3ed06be5a5834550` (port 5182)
**Result:** Edge.js NEVER calls `napi_open_handle_scope` from the
wasm side (0 calls across 18 wasm-routed tests, max depth 0 from
wasm's view).  All 4,913 scope opens happen INSIDE emnapi via
internal `Context.openScope` (callbacks + finalizers, never crossing
the wasm import boundary).  **The plan to "forward wasm-explicit
scope ops via RPC" would have been a no-op.**  Root-scope rotation
at quiescence points is the right pattern instead.

## The question

`host-emnapi-root-scope-accumulates` (NOTES.md) — host-worker.ts
opens ONE long-lived handle scope at init that never closes.
Production-clean would forward wasm-side scope ops via RPC so host's
scope discipline mirrors wasm's.  Is that feasible?  What's the
volume?

## Methodology

Three-layer instrumentation in `browser-target/src/napi-host/`:

1. **Wasm-explicit:** wraps `napi_open_handle_scope` /
   `napi_close_handle_scope` on `napiModule.imports.napi` — captures
   opens triggered by edge.wasm at the import boundary.
2. **Context-level:** monkey-patches `Context.openScope` /
   `closeScope` directly — captures EVERY open including emnapi's
   internal JS-side opens during callback dispatch + finalizer
   trampolines (these never cross the wasm import boundary).
3. **Depth histogram:** wraps every other `napi_*` function to
   record wasm-explicit depth at time-of-call.

E7-aware test runner reuses Vite (port 5182) + Playwright.  All 25
non-skipped tests pass with instrumentation active.

## Raw data — 30 tests collected

- **18 wasm-routed** (have E7 data)
- **7 host-routed** (`host=1` — bypass wasm via `OP_RUN_USER_SCRIPT`)
- **5 skipped** (pre-existing reasons)

**Top-10 noisiest wasm-routed tests:**

| Test | ops | wOpen | wClose | ctxOpen | ctxClose | ctxMaxD | ctxCurD |
|---|---:|---:|---:|---:|---:|---:|---:|
| response-body-consume | 17229 | 0 | 0 | 358 | 357 | 7 | 1 |
| tls-info | 15809 | 0 | 0 | 283 | 282 | 3 | 1 |
| tls-secure-context | 15510 | 0 | 0 | 298 | 297 | 4 | 1 |
| crypto-sha256 | 15397 | 0 | 0 | 282 | 281 | 4 | 1 |
| crypto-randombytes | 15296 | 0 | 0 | 285 | 284 | 4 | 1 |
| crypto-uuid | 15272 | 0 | 0 | 279 | 278 | 4 | 1 |
| policy-crypto-host-random | 15249 | 0 | 0 | 281 | 280 | 3 | 1 |
| http-server-listen | 14814 | 0 | 0 | 269 | 268 | 3 | 1 |
| https-server-listen | 14814 | 0 | 0 | 269 | 268 | 3 | 1 |
| policy-outbound-fetch-tunnel | 14457 | 0 | 0 | 268 | 267 | 3 | 1 |

All 18 wasm-routed tests: `ctxOpen ∈ [248, 358]`, `ctxMaxD ∈ [3, 7]`,
`ctxCurD = 1`.

## Suite-wide totals (18 wasm tests)

- Wasm-explicit `napi_open_handle_scope`: **0**
- Wasm-explicit `napi_close_handle_scope`: **0**
- `Context.openScope` (all callers): **4,913**
- `Context.closeScope` (all callers): **4,895**
- Total non-scope napi ops: **269,116**
- Max wasm-explicit depth: **0**
- Max Context depth: **7** (in `response-body-consume`)
- Wasm-explicit leaks: **0**
- Context-level leaks: **18** (exactly 1 per test — the root scope, by emnapi design)

**Depth histogram (wasm-explicit):** 100% of 269,116 ops at depth 0.
Edge.js never opens a scope from the wasm side.

## Cost projection (RPC @ ~31 µs from E4)

**Case A — forward only wasm-explicit calls:** 0 ops / 0 ms.
**But achieves nothing** — edge.js never calls them, so the host
root scope still accumulates.  The original NOTES.md plan as written
is a no-op.

**Case B — forward ALL `Context.openScope` calls:** 9,808 ops suite-
wide → ~304 ms suite cost, ~16.9 ms per test average.  Feasible
against current ~100-300 ms wasm runtimes, with a real semantic
benefit (host scope discipline mirrors wasm's internal usage).

## Feasibility verdict

1. **Wasm-explicit-only forwarding is cheap but useless** — edge.js
   doesn't call them.
2. **All-Context forwarding is feasible but expensive at scale.**
   Linear with workload: a 10k-request HTTP server would issue an
   estimated ~300k Context scope opens → ~9.3 s RPC cost.  Doesn't
   scale.
3. **Root-scope rotation at quiescence points** is the right pattern:
   - Flush at `unofficial_napi_release_env`
   - OR between RPC requests at known quiescence
   - OR periodic compaction when handle count exceeds a threshold

   Cheaper than per-call forwarding; achieves the same bounded-
   accumulation property.

## Caveats

- **Prod ≠ test.**  Long-running servers exhibit linear growth that
  18 short tests don't show.
- **`ctxMaxD = 7` in `response-body-consume`** is an outlier worth
  investigating; all other tests max at 3-4.  Likely a stream
  decode pipeline with nested callbacks.
- **The 31 µs RPC figure** comes from F-1/F-9 round-trip numbers;
  a dedicated micro-bench for tiny-payload scope ops would tighten
  the estimate.
- **18 Context-level "leaks" are by design** — the root scope from
  `createContext()` is intentionally never closed (closing it would
  invalidate all live handles).  Not a bug.

## Conclusion

The `host-emnapi-root-scope-accumulates` debt entry's prescribed fix
(forward wasm-explicit scope ops) is a no-op against today's
edge.js.  The debt is real (handles accumulate linearly with
request count) but the fix is **root-scope rotation at quiescence**,
not per-call forwarding.  Update NOTES.md accordingly; promote when
a deployment shows growth.

## Code (worktree, not merged)

- Instrumentation: `browser-target/src/napi-host/e7-scope-counters.ts`
  + wire-up in `browser-target/src/worker.ts`
- E7-aware runner: `experiments/e7-scope-discipline-observation/runner.mjs`
- Aggregator: `analyze.mjs`
- Raw dataset: `raw.jsonl` (30 records)
