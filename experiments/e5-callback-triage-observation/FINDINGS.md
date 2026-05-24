# E5: callback triage observation — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a6cfed050800df93a` (port 5180)
**Result:** Test suite is bootstrap-dominated; provides only weak
signal for hot-path classification.  Hot-path candidates per the F-9
plan (stream `_read`, llhttp parser hooks) **fire zero times** under
today's tests — the data E5 needed isn't available without driving
sustained load.

## The question

The F-9 plan called for a two-tier dispatch — cold callbacks via RPC,
hot ones via in-process — gated by an allow-list at
`napi_create_function` time.  The allow-list in
`browser-target/src/host-worker/callback-triage.ts` is empty.  Which
callbacks should populate it?

## Methodology

Instrumented `napi.imports.napi.napi_create_function` (in the wasm-
side `napi-host` shim) to monkey-patch each just-created closure with
a counting wrapper that preserves `new.target` (`Reflect.construct`)
and prototype chain.  First-fire captures a 3-frame stack snippet to
label the otherwise-anonymous `cb=<N>` funcref indices.  Per-test
counter map dumped via `[CALLBACK-TRIAGE-DUMP]` host-log line scraped
by a modified `browser-test-runner.mjs`.  Aggregated across all 25
expected-pass tests.

Side-finding: an initial attempt also wrapped per-property closures
emitted by `napi_define_class` (method / getter / setter funcrefs)
broke `_Hash.update` (crypto), TLS context setup, and the HTTP server
test — backed off to constructor-only counting.  See "Caveats".

## Top callbacks by total fires across 25 tests

| Rank | Total | Max/test | Caller hint (1st-fire stack) |
|-----:|------:|---------:|------------------------------|
|    1 |  2184 |      166 | `BuiltinModule.compileForInternalLoader` / `requireBuiltin` |
|    2 |   712 |       48 | `internalBinding` (C++ binding registry) |
|    3 |   504 |       28 | `node:buffer:1397` (Buffer module body setup) |
|    4 |   139 |       10 | `createUnsafeBuffer` / `createPool` |
|    5 |   132 |        9 | `Performance.now` (via `pollOneoffAsyncImpl`) |
|    6 |    98 |        8 | `setupWarningHandler` |
|    7 |    72 |        4 | `Buffer.asciiWrite` |
|    8 |    61 |        6 | `Buffer.utf8Write` |
|    9 |    45 |        5 | `createFromString` (buffer ctor helper) |
|   10 |    36 |        2 | `napi_has_property` (emnapi internal) |
|   14 |    21 |        2 | `process.processTicksAndRejections` (microtask drainer) |

**Summary stats:**
- 409 distinct callback identifiers created
- Only 77 ever fired
- Only 4 crossed ≥10 fires in any single test
- 7 microtask-only tests fire ZERO napi callbacks
- The other 18 share a near-identical bootstrap baseline (cb=1041
  ≈110×, cb=971 ≈38×, cb=2425 28×, cb=1643 9×)

## Recommendation (heavily caveated)

Initial entries for the hot-path allow-list, matched on **caller-
derived hint** (not on cbPtr — funcref indices are not stable across
wasm rebuilds):

1. `requireBuiltin` — node-lib module loader, 110-166 fires/test
2. `internalBinding` — C++ binding registry, 38-48 fires/test
3. `node:buffer:1397` (Buffer module body setup) — 28 fires/test
4. `createUnsafeBuffer` / `createPool` — buffer pool, 10 fires/test
5. `Buffer.asciiWrite` / `Buffer.utf8Write` — request-frequency-hot
   under string-heavy load
6. `Performance.now` — invoked from `pollOneoffAsyncImpl` every poll
   cycle; 9× in suite but hot in any I/O loop
7. `processTicksAndRejections` — microtask drain; only 2× in suite
   but canonical hot path under async load

## Caveats — these dominate

- **Tests don't drive sustained load.**  Stream `_read` and llhttp
  parser hooks — the canonical hot-path callbacks per the F-9 plan —
  fire ZERO times because nothing exercises the parser.  `webserver`
  is skipped.  The 4-7 above are the heaviest under cold bootstrap,
  not under real production traffic.
- **Today's test suite path is in-process.**  The host-RPC tier
  (`makeHostSideCallbackClosure` etc.) is NOT exercised by any
  existing test.  The wasm-side napi imports route directly to the
  page-side emnapi context.  By framing, the listed callbacks are
  what would slow down IF we cut them to RPC — i.e. they're what to
  KEEP in-process, not what to MOVE.
- Caller hint captured only on FIRST fire to keep overhead
  negligible.  A callback initially invoked from setup and later
  from a hot loop may be mislabeled.
- The anonymous `cb=<N>` indices are wasm `__indirect_function_table`
  slots and change on every wasm rebuild.  Allow-list shipped to
  prod must match on caller hint or on wasm-side names (currently
  empty).
- 5 skipped tests + missing in-test sustained-load drivers mean
  prod patterns are unmeasured.  An E8 follow-up that drives an
  HTTP server + parser hot path is the right way to validate.

## Conclusion

The data confirms the **two-tier dispatch architecture** is correct
(hot ops dominate any per-call RPC budget) but does NOT yet provide
a defensible production allow-list.  Defer the allow-list
implementation until either (a) sustained-load measurement lands
(E8 follow-up), or (b) a concrete deployment motivates forwarding
specific cold-path ops.

## Code (worktree, not merged)

- Instrumentation: `browser-target/src/napi-host/index.ts`,
  `worker.ts`, `scripts/browser-test-runner.mjs`
- Aggregator: `experiments/e5-callback-triage-observation/aggregate.mjs`
- Per-test dumps: `raw-data/<test>.json` (25 files)
