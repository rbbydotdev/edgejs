# R4: all-via-RPC boot overhead — findings

**Date:** 2026-05-23
**Status:** Acceptable up to ~30k boot napi calls; needs mitigation past 50k.

## The question

Edge.js's boot makes thousands of napi calls during lib/*.js init. If
every napi call becomes a SAB-RPC roundtrip, what's the boot-time
inflation? Is it sub-second (fine) or seconds (unacceptable)?

## Measurement (Node 24.16, macOS arm64)

`probe.mjs` mirrors the production `SyncRpcClient` shape: sync-caller
worker + async-drainer host, same SAB ring layout as `l5-sync-rpc` (8
slots × 256 B). 1k warmup, then stress at 10k / 50k / 100k iterations
across 8B / 32B / 128B payloads.

| Workload | p50 | p99 | p999 | mean per-call | per-1k |
|---|---|---|---|---|---|
| in-process baseline (32B × 100k) | 0.04 µs | 0.17 µs | — | 0.06 µs | 0.06 ms |
| sab-rpc 8B × 100k  | **13.08 µs** | 51.67 µs | 226 µs | 14.26 µs | 14.26 ms |
| sab-rpc 32B × 100k | **13.13 µs** | 51.83 µs | 169 µs | 14.66 µs | 14.66 ms |
| sab-rpc 128B × 100k | **13.25 µs** | 52.08 µs | 192 µs | 14.56 µs | 14.56 ms |

- Per-call cost is **flat across 8B → 128B** — protocol dominates, payload
  copy is noise.
- **Ratio: ~237× slower per call** vs. in-process.
- Tail: p999 sits 150–300 µs. Expect 1–2 multi-ms spikes per ~50k calls
  in real boot (GC pause / OS scheduling).

## Boot-inflation projections (per-call avg ≈ 14.49 µs)

| napi call count | added boot time |
|---|---|
| 10,000  | 145 ms  |
| 20,000  | 290 ms  |
| 50,000  | 725 ms  |
| 100,000 | 1,449 ms |

## Sanity check vs. main-project L3 echo bench

`experiments/OPEN-QUESTIONS.md` notes "L3 measured 22 µs per RPC call."
R4 measures **13 µs p50 / 14 µs mean** in Node. The production envelope
adds op-code switch + framed args + byte-aligned encoders this probe
omits, and Node's Atomics paths are ~1.5–2× faster than browser worker
threads. **Realistic browser RTT estimate: ~20–25 µs p50, ~50–80 µs p99
— matches L3.**

## Recommendation

**Acceptable up to ~30k boot napi calls; needs mitigation past 50k.**

- 10k → 150 ms: invisible.
- 30k → ~450 ms: noticeable but fine.
- 50k → ~750 ms: uncomfortable, near the "feels slow" wall.
- 100k → ~1.5 s: not OK.

**Next step (unknown):** instrument the production drainer with an
op-code histogram and **actually count napi calls during edge.js boot.**
Project from the table.

## Mitigation levers (ranked)

1. **Inline well-known handles.** `napi_get_undefined` / `get_null` /
   `get_global` / `typeof`-of-constants don't need the host JS engine —
   serve from a SAB-resident lookup table, no RPC. Estimated **20–40% of
   boot calls eliminated.**
2. **Batch op-codes** for property-access chains (very common in
   lib/*.js boot). 3–5× cut for those sequences.
3. Smaller slot size (256 → 64 B): marginal. Skip.
4. Async post-then-poll: hard to retrofit into emnapi's sync ABI; only
   worth it for finalizer-queue style ops.

The combination of (1) + (2) should be worth a **2–3× cut in boot RPC
volume** — pulling 50k effective calls down to ~15–25k, well inside
the comfortable zone.

## Notes / debugging gotchas

- `worker.terminate()` immediately on "done" can swallow worker stdout
  mid-flush. Use `worker.on("exit", ...)` instead.
- 10 s default sync-call timeout is too tight under sustained 100k
  stress; bumped to 30 s in the probe.

## Status for path (a)

**Risk quantified, not retired.** The number depends on edge.js's real
boot call count. Next step before full cutover: instrument a boot
profile to count napi ops. Mitigations are well-defined if the count
exceeds budget.

## Follow-up B1 (2026-05-23): real boot call counts measured

Used the existing `browser-target/src/trace.ts` per-op histogram
(already wired; no code changes needed) to count napi calls during
3 boot scenarios via `browser-test-runner.mjs`:

| Scenario | Test | Total napi calls | Projected RPC @ 14 µs |
|---|---|---|---|
| Minimum | `tests/js/log.js` | **14,648** | 205 ms |
| Realistic | `tests/js/crypto-sha256.js` | **15,645** | 219 ms |
| Heavy | `tests/js/response-body-consume.js` | **17,479** | 245 ms |

All three land **comfortably under the 30k threshold** ("acceptable"
bucket from the R4 table above). Heavy boot adds only ~2.8k calls
over minimum — meaning **~14.6k of the total is fixed Node-runtime
bootstrap** independent of user code.

### Top-10 ops (heavy boot, representative shape across all 3)

| Rank | Op | Count | % | Inline-able? |
|---|---|---|---|---|
| 1 | `napi_create_string_utf8` | 3,693 | 21.1% | No (TIER D — alloc) |
| 2 | `napi_set_element` | 2,889 | 16.5% | No (TIER D — side-effect) |
| 3 | `napi_set_named_property` | 1,974 | 11.3% | No (TIER D — side-effect) |
| 4 | `napi_typeof` | 1,137 | 6.5% | Partial (TIER B for reserved handles only) |
| 5 | `napi_define_properties` | 958 | 5.5% | No (TIER D) |
| 6 | `napi_create_int32` | 688 | 3.9% | No (TIER D — alloc) |
| 7 | `napi_get_value_string_utf8` | 686 | 3.9% | No (TIER D) |
| 8 | `napi_has_named_property` | 632 | 3.6% | No (TIER D) |
| 9 | `napi_get_named_property` | 616 | 3.5% | Partial (TIER C if cached) |
| 10 | `napi_create_function` | 459 | 2.6% | No (TIER D — reverse channel) |

Top-3 = 49% of calls; top-10 = 78%. **None of the top-3 are inline-able.**

### Inline-candidate audit (B2 vs B1)

A parallel static-analysis pass (B2) estimated TIER-A inlining
(`get_undefined`, `get_null`, `get_boolean`, `get_global`) would save
"25-35%" of boot RPCs, based on static call-site density in edge.js's
C source.  **B1's dynamic histogram contradicts that:** TIER-A ops are
only ~2% of actual calls (e.g. `napi_get_undefined` ranks #13 at
1.8%).  The static count overestimated because many call-sites are in
error-return paths that don't fire during a successful boot.

The real high-impact lever, if ever needed, is **batching** at the
protocol level: the `set_element` / `set_named_property` /
`define_properties` ops account for ~33% of boot calls and are
typically issued in tight loops during table setup.  Batching those
into a single RPC would cut volume meaningfully — but **at 17k calls
per heavy boot, batching is not currently warranted.**

## Final verdict for path (a)

**Boot RPC overhead is NOT a blocker.** No mitigations needed before
beginning the full napi cutover.  If the count ever creeps past 30k
(e.g. a larger lib surface), the well-defined lever is op-batching on
the top-3 property-setup ops.
