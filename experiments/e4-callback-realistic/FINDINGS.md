# E4: realistic callback end-to-end perf — findings

**Date:** 2026-05-23
**Result:** Quantified. **Two-tier dispatch is the right model** — RPC for
cold-path callbacks, co-located in-process for hot-path callbacks.

## The question

What's the real per-fire latency of a typical napi callback (3 args,
inspect via napi, return) on the reverse-RPC path? Are hot-path
callbacks (stream `_read`, parser hooks, EventEmitter on hot emitters)
viable on RPC?

## Per-fire latency (Node 24.16, macOS arm64; 2000 iters/mode)

| mode | min | median | mean | p99 | p999 |
|---|---:|---:|---:|---:|---:|
| in-process baseline | 0.04 µs | **0.13 µs** | 0.19 | 0.88 | 4.75 |
| naive (3 forward RPCs for arg inspection) | 70 | **78** | 82 | 162 | 191 |
| bundled (args inline in reverse payload) | 28 | **31** | 34 | 71 | 114 |

**Multipliers vs in-process:**
- naive ≈ **580×**
- bundled ≈ **240×**

Cost decomposition matches R4 (~14 µs/RPC) + R6a (~30-50 µs per nested
level). Bundled = 2× one-way trip. Naive = bundled + N forward inspects.

## Hot-path projections (median per-fire × N fires per event)

| scenario | in-process | naive | bundled |
|---|---:|---:|---:|
| EventEmitter listener (10 fires) | 1.3 µs | 780 µs | **315 µs** |
| HTTP middleware chain (50 fires) | 6.3 µs | 3.9 ms | **1.6 ms** |
| Stream `_read` per chunk (100 fires) | 13 µs | 7.8 ms | **3.2 ms** |
| Per-byte parser callback (1000+ fires) | 130+ µs | 78+ ms | **31+ ms** |

## RPC-viability by callback category

| category | typical fire rate | bundled cost | verdict |
|---|---|---:|---|
| Setup callbacks (boot-time defineProperty, etc.) | once | 31 µs | **fine** |
| Promise resolution, `process.nextTick` user CB | 1-10× / event | < 0.5 ms | **fine** |
| Cold EventEmitter listeners | 1-10× / event | < 0.5 ms | **fine** |
| HTTP middleware chain | 20-50× / req | 1.6 ms | **borderline** — 50 req/s = 80 ms/s CPU just for RPC |
| Stream `_read`/`_write` per chunk | 100s× / chunk | 3.2 ms | **NOT viable** — kills streaming |
| Per-byte parser callbacks (llhttp, etc.) | 1000s× / req | 31+ ms | **NOT viable** |

## Recommendation: two-tier callback dispatch

**Always bundle args.** Naive arg-inspection round-trips are 2.5× slower
for zero design upside; bundling pays for itself after a single arg.

**Architectural model:**

- **RPC tier (cold path):** route via reverse RPC + bundled args.
  Acceptable for any callback firing < ~10× per event. Covers ~90%
  of edge.js's callback surface — setup, finalizers, error handlers,
  one-shot event listeners, Promise resolution.

- **Co-located tier (hot path):** keep the napi callback dispatch on
  the WASM worker via the existing in-process `napi-host/` path.
  Specifically required for: parser callbacks (llhttp, simdjson-style),
  stream `_read`/`_write` per-chunk callbacks, EventEmitter listeners
  on high-frequency emitters (`net.Socket`/`stream.Readable` `data`).

**Triage mechanism:** at `napi_create_function` time, host inspects
the call site / caller identity. Callbacks bound through known hot
paths (allow-list maintained in `browser-target/src/`) get an
in-process dispatch handle (no RPC); everything else gets the
bundled-RPC wrapper. Default to bundled-RPC; opt-in to co-located
via the allow-list.

## Strategic implication for Lever B

**The in-process napi-host should NOT be archived.** It has a real
production role: hot-callback dispatch. F-7's original brief
(`archive in-process napi-host, drop __edgePromisingDepth`) is wrong
in framing — the in-process path is permanently load-bearing for
streaming/parsing performance, regardless of how much of the napi
surface moves to RPC.

This vindicates F-7's scope-adjusted reality (kept both paths) and
sets a clear architectural direction: dual-path is the END STATE,
not a transitional waypoint.

## Status for path (a)

**Risk retired with a design change.** Full napi cutover at the
WIRE level (all ops via RPC) is no longer the goal — that was based
on the implicit assumption that all callbacks would be RPC-viable.
E4 disproves that for hot paths.

The new endgame:
1. The 93 ops already migrated stay migrated.
2. Remaining 13 callback ops get a triage mechanism — most flow
   through reverse RPC (bundled args); hot-path callbacks stay
   in-process.
3. In-process `napi-host/` remains in tree as the hot-path dispatcher.
4. No "default flip" is needed; both paths coexist by design.

## Files

- `experiments/e4-callback-realistic/probe.mjs`
- `experiments/e4-callback-realistic/package.json`
