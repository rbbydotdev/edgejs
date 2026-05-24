# E11: async offload policy retry — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a7008124b186946dd` (port 5186)
**Result:** **Works.  Ship as opt-in.**  `compression-via-compressionstream`
is functional today after a 2-line bug fix.  Full suite stays green
(now 27 pass, was 25 — added 2 E11 tests).  Importantly: this policy
is currently **the only working async zlib path** on the wasm browser
target; the bundled wasm zlib crashes with `ERR_INTERNAL_ASSERTION:
have should not go down` (separate bug).

## Why the docs said "callback never fires"

NOTES.md previously framed this as "blocked-by-#1: every host-async
policy needs Promise continuations to resolve inside edge's context".
E8 debunked that blocker.  Two REAL bugs in the policy code were the
actual cause:

1. **`new CompressionStream(format)` reached edge's bundled class,
   NOT the host's native.**  Edge's bootstrap installs
   `globalThis.CompressionStream` as a getter for
   `lib/internal/webstreams/compression.js` — a class that wraps
   `createGzip()` / `createGunzip()` from the bundled zlib.  So the
   policy round-tripped right back to the engine it was supposed to
   bypass.  This is the exact "edge mutates globalThis mid-bootstrap"
   pattern that the existing crypto-host-random policy works around
   via `__edgeHostNativeCrypto`.
2. **`process.nextTick(cb)` swallowed the second-and-later callback
   in a chained call** (e.g. `gzip → gunzip → ...`).  First nextTick
   drained fine; the inner nextTick queued from inside the outer
   callback's Promise chain didn't drain before `_start` ran out of
   work.  Symptom: first callback fires, second silently doesn't,
   process returns (no `exit=0`).

## Fix

Two files (mirrors the existing crypto-host-random pattern):

- `browser-target/src/host/globals-shim.ts` — snapshot native
  `CompressionStream` and `DecompressionStream` as
  `globalThis.__edgeHostCompressionStream` /
  `__edgeHostDecompressionStream` (non-configurable, pre-bootstrap).
- `browser-target/src/policies/compression-via-compressionstream.ts`
  — read those snapshots; drop `process.nextTick`; fire the callback
  directly off the host Promise resolution.  Still async (matches
  zlib's stream-based path, which also doesn't go through nextTick).

## Tests added

- `tests/js/e11-policy-gzip.{js,harness-args,stdout}` — gzip+gunzip
  roundtrip via the policy
- `tests/js/e11-policy-deflate.{js,harness-args,stdout}` — deflate /
  inflate + deflateRaw / inflateRaw roundtrip

Both PASS.  Suite: 27/27 (was 25/25).

## Perf

50× gzip of 1 KB ASCII:
- With policy: **5-6 ms total / 0.10-0.12 ms per op**
- Without policy: bundled wasm async zlib **crashes** on first call
  (`ERR_INTERNAL_ASSERTION: have should not go down`).  No baseline
  measurable.

So "perf delta vs bundled zlib" isn't applicable today: the policy is
the only working async zlib path.

## Recommendation

**Ship as opt-in (status quo).**  Two reasons stronger than the docs
suggested:
1. It fixes a hard crash, not just a perf gap.
2. It validates the broader async-host-offload framing.  Other
   "blocked-by-#1" policies (`crypto-via-subtle`,
   `wasm-compile-via-host`, `streams-via-web-streams`) likely need
   the same `globals-shim` snapshot pattern — same root cause (edge
   shadowing the host global).

Don't default-enable yet: `gzipSync` and the stream-based `createGzip`
users still go through the (broken) bundled path; those are separate
policies.

## Open questions

1. The `ERR_INTERNAL_ASSERTION: have should not go down` in the
   bundled wasm zlib — likely related to the same wasm-aliased Buffer
   plumbing that already needed `bufferWasmAliased`.  Repro is
   trivial: any `zlib.gzip(...)` without the new policy.  Worth a
   separate investigation.
2. The "nextTick queued from inside an inner Promise gets dropped"
   shape — probably the same residual nextTick-timing E10 saw for
   `unhandled-rejection-fires`.  If E10's fix (drain tick queue from
   host event handler) also handles this case, the policy could go
   back to Node-honest `process.nextTick(cb)`.
3. Apply the same `globals-shim` snapshot trick to `crypto.subtle` —
   quick win toward `crypto-via-subtle`.

## Files changed in main

- `browser-target/src/host/globals-shim.ts` — `__edgeHostCompressionStream`
  + `__edgeHostDecompressionStream` snapshots
- `browser-target/src/policies/compression-via-compressionstream.ts`
  — read snapshots; drop nextTick deferral
- `tests/js/e11-policy-{gzip,deflate}.{js,harness-args,stdout}` —
  new tests
