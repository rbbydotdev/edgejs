# Agent C: Hmac via napi-memory data channel

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a1ab19703b1114dd5`
**Result:** Shipped.  Suite: 37/0/3 → 38/0/3.  Mirror of E22 for HMAC.

## Wire format

New op: `OP_SUBTLE_HMAC_VIA_NAPI_MEM = OP_DOMAIN_HOST_API | 0x0004`.

RPC slot payload (<100 B regardless of key/data size):
```
[u32 algo_name_len][utf-8 algo_name]
[u32 key_offset][u32 key_len]
[u32 data_offset][u32 data_len]
```

## Memory region — SHARED with digest staging

Key and data both live in `napiHostMemory.buffer` inside the existing
128 KiB staging region E22 already reserved:
- Key: `[DIGEST_STAGING_OFFSET, DIGEST_STAGING_OFFSET + alignedKeyLen)`
- Data: `[DIGEST_STAGING_OFFSET + alignedKeyLen, ...)`, where
  `alignedKeyLen = (keyLen + 7) & ~7`

Safe to share because both ops are single-flight via sync RPC
(`Atomics.wait` blocks the wasm thread until the host reply lands —
mutual exclusion guaranteed).  64 KiB key + 64 KiB data = 128 KiB
combined fits exactly without bumping napi memory pages.

## Implementation

- `rpc-protocol.ts`: op decl + wire format doc (+27 LOC)
- `host-worker.ts`: handler reads `(algo, keyOff, keyLen, dataOff,
  dataLen)`, copies key+data to JS-heap (SubtleCrypto rejects SAB
  views), calls `subtle.importKey('raw', ...)` + `subtle.sign('HMAC',
  ...)`.  (+86 LOC)
- `worker.ts`: `installHostHmacSyncGlobal` now dispatches based on
  combined frame size — small inputs use the existing `OP_SUBTLE_HMAC`
  fast path; large inputs write key+data into the staging region and
  use the new op.  (+50 LOC modified)

## Test

`tests/js/crypto-hmac-via-host-worker-large.{js,harness-args,stdout}`

Coverage:
- 5000 B data with short key (first size above E21's ~4055 B cap)
- 32 KiB key + 32 KiB data SHA-256
- 64 KiB key + 64 KiB data across all 4 algos (SHA-1/256/384/512)
- Chunked multi-update on 64 KiB data
- Small HMAC after large activations (proves small path still works
  once staging region is touched)

Expected hex generated via Node 22's bundled OpenSSL — bit-exact match.

## Caveats

- **Staging cap is 128 KiB combined** (key + data).  Above that, clear
  error tells caller to disable the policy.  Workaround: bump
  `napiHostMemory` pages (4 init / 16 max → up to 1 MiB possible if
  grown).  Not done here since the task target fits exactly.
- **Pool-allocator collision** (inherited from E22): napi handle bump
  allocator capped at `POOL_ALLOC_CEILING = DIGEST_STAGING_OFFSET`.
  Handles currently use ~16 KiB; warn-log only, no hard stop.
- **Integration gotcha**: initial copy of `worker.ts` and
  `rpc-protocol.ts` didn't take (silent cp failure on first run);
  required re-copy.  Suite was briefly 36/1/3 before re-copy succeeded.
  Lesson: verify file contents post-copy, don't trust exit codes alone.

## Files changed in main

- `browser-target/src/host-worker/rpc-protocol.ts`
- `browser-target/src/host-worker/host-worker.ts`
- `browser-target/src/worker.ts`
- `tests/js/crypto-hmac-via-host-worker-large.{js,harness-args,stdout}`
