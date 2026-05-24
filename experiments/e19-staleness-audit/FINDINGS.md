# E19: audit of lib/ for JS-heap typed-array staleness bug — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-ac316bb4f08c85a68`
**Mode:** Audit only — no code changes.
**Result:** 4 new HIGH-confidence sites found, 3 known (zlib, fixed),
0 medium, 12 documented as SAFE.  Recommendation: write a focused
policy for the 4 new cases.  No general napi-layer fix needed.

## Pattern being audited

The bug class identified by E13/E15:
- JS allocates a small typed array
- Hands it to a C++ binding
- Binding retains the pointer and writes through it (sync or async)
- JS reads the typed array expecting fresh values
- BUT: host's `napi_get_typedarray_info` override syncs wasm→JS
  BEFORE the C++ write — so JS sees state ONE call behind wasm

For zlib this was loud (assertion crashes).  This audit asked
whether other lib/ modules have the same pattern (loud or silent).

## Scanned

~50 typed-array allocations and ~25 binding handoff sites across:
- `lib/zlib.js`, `lib/dgram.js`, `lib/tls.js`, `lib/_tls_*.js`
- `lib/internal/http2/*.js`, `lib/internal/dgram.js`
- `lib/internal/stream_*.js`
- `lib/internal/crypto/*.js`
- `lib/internal/url.js`, `lib/_http_common.js`, `lib/url.js`,
  `lib/querystring.js`
- `lib/internal/buffer.js`
- `lib/internal/streams/fast-utf8-stream.js`
- `lib/internal/quic/stats.js`
- `lib/internal/modules/esm/hooks.js`
- `lib/internal/process/per_thread.js`
- `lib/internal/worker.js`
- `lib/v8.js`

## HIGH confidence — NEW (E20 follow-up)

All four in `lib/internal/process/per_thread.js`:

| # | Line | Allocation | Binding | C++ callback |
|---|---:|---|---|---|
| 1 | 123 | `const cpuValues = new Float64Array(2);` | `binding._cpuUsage(cpuValues)` | `src/edge_process.cc:4484` |
| 2 | 163 | `const threadCpuValues = new Float64Array(2);` | `binding._threadCpuUsage(...)` | `src/edge_process.cc:4504` |
| 3 | 215 | `const memValues = new Float64Array(5);` | `binding._memoryUsage(...)` | `src/edge_process.cc:4528` |
| 4 | 329 | `const resourceValues = new Float64Array(16);` | `binding._resourceUsage(...)` | `src/edge_process.cc:4558` |

All four C++ callbacks use `GetFloat64ArrayData(env, argv[0], N,
&values)` (`src/edge_process.cc:922`), which goes through
`napi_get_typedarray_info` (the override at
`browser-target/src/napi-host/index.ts:394-399` syncs wasm→JS first),
then writes N doubles via raw pointer.  JS then reads
`cpuValues[0]` etc. from JS-heap → STALE.

**Difference from zlib:** these are SYNC calls (not async
completion).  First call returns `0,0` (initial cache).  From the
second call onward, JS sees the PREVIOUS call's values.  Public APIs
affected: `process.cpuUsage()`, `process.memoryUsage()`,
`process.resourceUsage()`, `process.threadCpuUsage()`.

**Failure mode: silent stale data, no crash.**  Worse than zlib's
loud failure — observable problems in monitoring code that nobody
notices is wrong.

## HIGH confidence — KNOWN (E15-fixed, listed for verification)

- `lib/zlib.js:674` (`Zlib._writeState`) — `new Uint32Array(2)`
- `lib/zlib.js:836` (`Brotli._writeState`)
- `lib/zlib.js:895` (`Zstd writeState`)

Already remediated by
`browser-target/src/policies/zlib-writestate-wasm.ts`.  Audit
catches them as HIGH, confirming methodology.

## MEDIUM confidence

**None.**  Clear split between HIGH (retained module-scope TAs) and
SAFE (one-shot or C++-allocated).

## LOW / SAFE list (with reasons)

- `lib/v8.js:153-155` — `heapStatisticsBuffer`, etc.: C++-allocated
  via `napi_create_arraybuffer`, wasm-aliased.
- `lib/internal/process/per_thread.js:73, 76` — `hrValues`,
  `hrBigintValues`: views over `binding.hrtimeBuffer` (C++-
  allocated, wasm-aliased).
- `lib/internal/http2/core.js:1169, 1341` — placeholder
  `kNativeFields` replaced by `handle.fields` (C++-allocated,
  wasm-aliased) at line 1112.
- `lib/internal/http2/core.js:1126, 1132` — views over wasm-aliased
  `handle.fields.buffer`.
- `lib/zlib.js:805, 916, 930` — `brotliInitParamsArray`,
  `zstdInitCParamsArray`, `zstdInitDParamsArray`: JS→C++ one-shot,
  no retention.
- `lib/internal/worker.js:633` — `resourceLimitsArray`: JS→C++
  one-shot.
- `lib/internal/crypto/{ml_kem,ml_dsa,rsa,argon2,diffiehellman}.js`
  — small `Uint8Array(N)`: one-shot key/data buffers, returned or
  consumed inline.
- `lib/_http_common.js:217`, `lib/internal/url.js:1337`,
  `lib/url.js:627`, `lib/querystring.js:60,146` — module-level
  constant lookup tables.  Pure JS-only.
- `lib/internal/buffer.js:43-46` — endianness-detection scratch.
  Never crosses napi.
- `lib/internal/streams/fast-utf8-stream.js:53` (`kNil`) — SAB +
  Atomics.  Worker-thread, unreachable in browser-target.
- `lib/internal/quic/stats.js:156, 314, 546` (`new BigUint64Array(
  buffer)`) — views over passed AB; no QUIC binding exists in
  browser-target, unreachable.
- `lib/internal/modules/esm/hooks.js:535` — SAB + Atomics,
  worker-only.

## Pattern observations

- HIGH cases share: **module-scope TA + C++ writes through TA on
  each sync call**.  The "no C++ ref retention" is irrelevant —
  what matters is that the JS-heap copy never gets the wasm→JS sync
  after the write.
- **Naming heuristic**: suffix `Values` correlates with JS-allocated
  TA (4/4 HIGH); suffix `Buffer` correlates with C++-allocated
  (`heapStatisticsBuffer`, `hrtimeBuffer`).  Useful for future
  audits.
- The four `per_thread.js` cases are the ONLY Node-lib JS modules
  with sync module-level TAs that get written by C++.  Everything
  else either is a constant table, is wasm-aliased from source, or
  is JS→C++ direction only.
- The `_writeState` family (zlib) is the ONLY async retention case
  in `lib/`.  Async retention is what made zlib's bug user-visible
  (assertion fired).  The new four cases are silent — they return
  stale-by-one numbers with no crash.

## Recommendation

**Write `process-methods-wasm-state` policy** (E20).  Wraps
`cpuUsage`/`threadCpuUsage`/`memoryUsage`/`resourceUsage` to swap
each internal `Float64Array` for a wasm-backed twin via
`internalBinding('buffer').createUnsafeArrayBuffer`.

Smaller surface than zlib:
- No per-instance creation (4 module-scope TAs)
- No class hierarchy
- No async retention

**Ship in `defaultBrowserPolicies` + `minimalPolicies`** —
correctness fix for widely-used public APIs.

Estimated effort: ~30-line policy + 1 test exercising all four
APIs.

## No general napi-layer fix needed

Per E13's analysis (and confirmed by this audit): the napi-layer
intercept would require invalidating JS's direct reference to the
typed array's backing buffer.  That's not possible without rewriting
emnapi internals.  The per-binding policy pattern works and is
bounded: the audit found only 5 distinct sites (3 zlib + 4
per_thread.js).

If a sixth site emerges later, repeat the pattern: small policy +
optional helper extraction if it becomes mechanically duplicative.
