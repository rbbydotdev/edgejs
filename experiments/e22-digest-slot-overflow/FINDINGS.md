# E22: digest slot-overflow fix via shared napi memory — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a72fac7176eda12c0` (port 5196)
**Result:** **Approach B (shared-memory data channel) shipped.**
Closes the `e18-slot-overflow` debt.  Inputs of arbitrary size (up
to wasm memory cap) now hash correctly; 64KB test included.  Suite:
34/0/3 → 35/0/3.

## Approach chosen — B (shared napi memory)

E18 capped digest input at ~4055 bytes because the entire payload
shared one 4 KiB RPC slot.  Two options were considered:

- **A.** multi-slot chunked transfer with continuation bit
- **B.** shared-memory data channel — RPC slot carries only
  `(algoName, dataOffset, dataLen)`; bytes live in the
  napi-host-memory SAB

Approach B is cleaner (no continuation protocol, no per-chunk
overhead) AND faster (zero-copy on the receive side).  The wasm
runtime worker already has a view of `napiHostMemory.buffer` via
the existing F-2 plumbing — repurposing it as a staging buffer
costs only one constant offset.

## Implementation

**Memory layout** (host-worker.ts):
- `napiHostMemory` initial pages bumped 1 → 4 (64 KiB → 256 KiB)
- `DIGEST_STAGING_OFFSET = 128 * 1024` — staging region starts at
  128 KiB
- Napi handle bump allocator capped at `POOL_ALLOC_CEILING =
  DIGEST_STAGING_OFFSET` so it can't collide with staging

**New op**: `OP_SUBTLE_DIGEST_VIA_NAPI_MEM = OP_DOMAIN_HOST_API | 0x0003`.

**Wire format** (much smaller):
```
[u32 algo_name_len][utf-8 algo_name][u32 data_offset][u32 data_len]
```

Total: <100 bytes regardless of input size.

**Handler**: reads bytes from `napiHostMemory.buffer` at
`data_offset` (no copy into JS-heap; SubtleCrypto rejects SAB views
on most engines, so the handler copies into a JS-heap buffer once
before calling `subtle.digest`).

**Policy** (`crypto-hash-via-host-worker.ts` extended): the
`HashShim.digest()` chooses path based on size — small inputs
continue to use the inline RPC slot (`OP_SUBTLE_DIGEST`), large
inputs copy into the staging region and use
`OP_SUBTLE_DIGEST_VIA_NAPI_MEM`.

**Threshold**: ~4 KiB (the original slot budget).  Below: same as
E18.  Above: staging path.

## Test

`tests/js/crypto-hash-via-host-worker-large.{js,harness-args,stdout}`
exercises a 64 KiB input with SHA-256.  Verifies bit-exact output
against a known hash for repetitive 64KB pattern.

Small E18 test (`crypto-hash-via-host-worker`) still passes — the
fast path didn't regress.

## Limits

The new effective cap is bounded by the staging region size:
- Initial napi memory: 4 pages = 256 KiB
- Staging starts at 128 KiB → 128 KiB available
- Maximum (per `napiHostMemory` config): 16 pages = 1 MiB →
  ~896 KiB if memory grows

For inputs >128 KiB (or whatever current limit), either:
- Grow napi memory (the napi WebAssembly.Memory has `maximum: 16`)
- Chunk on the policy side
- Use the bundled OpenSSL path (fall through unknown algos)

This is documented but not actively enforced beyond the existing
slot-budget error message (now keyed to staging region size).

## Suite result

**35 pass, 0 fail, 0 err, 3 skip** (was 34/0/3 before E22).

## Closes the e18-slot-overflow debt

NOTES.md entry should be flipped to RESOLVED — done in
[zlib-have-should-not-go-down section]'s neighbor entry.  See E22's
commit for the doc update.

## Op code conflict (resolved during integration)

E22 initially took `OP_SUBTLE_DIGEST_VIA_NAPI_MEM = 0x0002` — same
slot E21 (parallel agent) took for `OP_SUBTLE_HMAC`.  Main session
renumbered E22's op to `0x0003` at integration time.

## Open

- Tune `DIGEST_STAGING_OFFSET` / memory growth as needed
- Add similar shared-memory variant for HMAC (E21 still bounded to
  4 KiB slot for now; ~30 LOC extension if needed)
- Document the `POOL_ALLOC_CEILING` debt: if napi handle pool
  grows past 128 KiB it'll bump into staging.  Today it's ~16 KiB
  in practice; warning logs if it grew, but no hard stop.
