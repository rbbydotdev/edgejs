# Agent D: createHash size-threshold fallback to bundled OpenSSL

**Date:** 2026-05-24
**Worktree (deleted):** `agent-ac843945eca63efa9`
**Result:** Shipped.  Suite: 37/0/3 → 38/0/3.

## Threshold + reasoning

`LARGE_INPUT_THRESHOLD = 1 * 1024 * 1024` (1 MiB).  Sits comfortably
above the E22 staging cap (~128 KiB) so the user-facing fallback
always fires before the staging guard would; covers typical multi-MB
file-hash workloads without paying the SubtleCrypto round-trip.

## Implementation

Single file change: `browser-target/src/policies/crypto-hash-via-host-worker.ts`.
~17 LOC added inside `HashShim.digest()`:

```js
if (totalLen > LARGE_INPUT_THRESHOLD) {
  var fallback = origCreateHash(algo, options);
  for (var fi = 0; fi < chunks.length; fi++) {
    fallback.update(chunks[fi]);
  }
  chunks = null;
  return encoding ? fallback.digest(encoding) : fallback.digest();
}
```

Caller sees the correct bytes and doesn't know which path produced
them.  Existing fast-path / napi-mem path behavior unchanged for
inputs below the threshold.

## Test

`tests/js/crypto-hash-large-fallback.{js,harness-args,stdout}` —
2 MiB SHA-256 of `Buffer.alloc(2*1024*1024, 'x')`.  Expected hex
`6932fd31e5daf4739b9fa78ff777b2831b0995cc1d0b0093cac80601902013bc`
(via Node bundled OpenSSL on same byte pattern).

## Decision: only fall back at `digest()`, not `update()`

`update()` doesn't know whether more bytes are coming — pre-checking
would prematurely commit to one path.  The buffered-chunks model
already supports "decide late": at `digest()` time every byte is
known, and replaying buffered chunks through `origCreateHash` is
bit-identical to a fresh stream-hash, so switching is correct.

Memory cost of buffering huge streams in JS-heap is unchanged from
pre-fix; the proper long-term answer for true streaming is a
`Transform`-shaped Hash shim, out of scope here.

## Gap (documented, not fixed)

Inputs in the 128 KiB–1 MiB band still go to the host-worker path
and may trigger the E22 staging-overflow throw — unchanged from
pre-fix in that range.  Either lower the threshold to ~96 KiB to
close the gap, or grow `napiHostMemory` to extend staging.  Kept at
1 MiB per spec.

## Files changed in main

- `browser-target/src/policies/crypto-hash-via-host-worker.ts`
- `tests/js/crypto-hash-large-fallback.{js,harness-args,stdout}`
