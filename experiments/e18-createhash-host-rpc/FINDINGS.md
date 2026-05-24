# E18: crypto.createHash via worker + sync-RPC — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a57dac615170e57ef` (port 5193)
**Result:** **Shipped opt-in.  Surprising perf win.**  E17's projection
of ~1ms RPC tax was order-of-magnitude pessimistic — measured ~25-50 µs
per call.  Host SubtleCrypto is FASTER than wasm-bundled OpenSSL for
small/medium inputs (1.9-4× speedup).  Suite: 32/0/3 → 33/0/3.

## Wire format

New op domain `OP_DOMAIN_HOST_API = 0x0600` (host-API-bridge ops:
SubtleCrypto.digest is the first; future host APIs that policies
route via worker+sync-RPC).

`OP_SUBTLE_DIGEST = 0x0601`.

Request payload (LE u32 lengths, contiguous bytes):
```
[u32 algo_name_len][utf-8 algo_name][u32 data_len][data]
```

`algo_name` is the canonical WebCrypto form (`"SHA-256"`, etc.); the
Node→WebCrypto mapping lives in the policy.  Reply payload: raw digest
bytes (SHA-1=20, SHA-256=32, SHA-384=48, SHA-512=64).  Status
`REPLY_STATUS_HOST_ERROR` on subtle.digest rejection with UTF-8 error
in payload.

## Handler (host-worker.ts)

~30 LOC.  Parses framed payload, calls
`globalThis.crypto.subtle.digest(algoName, dataCopy)` (data always
copied into JS-heap because SubtleCrypto rejects SAB views in many
engines), copies result bytes back.  Plus typed-error returns on bad
frames.

## Sync forward client + bridge global (worker.ts)

The reverse channel (host→wasm) already had `SyncRpcClient` (F-9
path-a).  The forward channel (wasm→host) previously had only the
async `RpcClient`.  E18 added a parallel `hostRpcSyncClient:
SyncRpcClient` on the SAME forward rings, plus an
`installHostDigestSyncGlobal()` that sets
`globalThis.__edgeHostDigestSync(algoName, bytes) → Uint8Array` — the
policy's contract.  The global frames args, calls
`callSync(OP_SUBTLE_DIGEST, ...)`, parks the wasm thread via
`Atomics.wait` on the shared-wake SAB, returns the reply bytes
synchronously.

## Policy (`crypto-hash-via-host-worker.ts`)

~120 LOC incl. comments.  `{ post }` patch on `lib/crypto.js`:
- Reads `globalThis.__edgeHostDigestSync`; refuses to install if
  absent (graceful degradation).
- Algo map: `sha1/sha256/sha384/sha512` → WebCrypto `SHA-N`.  Unknown
  algos fall through to the captured `origCreateHash` (so bundled
  OpenSSL still handles MD5 etc.).
- `HashShim.update()` buffers chunks (SAB-aware via `Buffer.from(
  input, enc)` then JS-heap copy).
- `HashShim.digest(encoding)` concatenates chunks, calls
  `hostDigestSync(...)`, returns Buffer (no encoding) or
  hex/base64/base64url/latin1/binary/utf8 string.
- Throws on `digest()`-after-`digest()` (matches Node).
- **Opt-in.**  Not in `defaultBrowserPolicies`.

## Test results

`tests/js/crypto-hash-via-host-worker.{js,harness-args,stdout}` covers
six cases: SHA-256 of "hello", SHA-256 of empty, SHA-1 of "hello",
chunked two-update, no-encoding Buffer return, SHA-384.

Browser suite: **33 pass, 0 fail, 0 err, 3 skip** (was 32/0/3).  The
`crypto-hash-via-host-worker` test passes via the policy path;
`crypto-sha256.js` still passes via bundled OpenSSL (policy is opt-in;
baseline tests don't enable it).

## RPC latency (Chromium 137, JSPI on)

| Workload | bundled OpenSSL (wasm) | host SubtleCrypto via RPC | Speedup |
|---|---:|---:|---:|
| 5 B / SHA-256 / 200 iters | 0.095 ms/op | 0.050 ms/op | **1.9×** |
| 512 B / SHA-256 / 200 iters | 0.100 ms/op | 0.025 ms/op | **4×** |
| 2048 B / SHA-256 / 200 iters | 0.085 ms/op | 0.025 ms/op | **3.4×** |

E17's projection (~1ms RPC tax) was an order of magnitude pessimistic.
Measured cost is ~25-50 µs per call.  The wait wakeup is
microsecond-scale `Atomics.wait` on the shared-wake SAB; SubtleCrypto
inside V8 dispatches to the same AVX SHA primitives the host has.
Host-native SHA beats wasm-bundled OpenSSL for these sizes.

## Open questions

1. **Hmac via the same path** —
   `SubtleCrypto.sign({name:'HMAC'}, key, data)` is the natural next
   op.  Same sync-vs-async gap; wire shape extends with a key-bytes
   preamble.  Patch site: `lib/internal/crypto/mac.js`.  E14 noted
   Hmac is "likely the higher-value target" — agreed.
2. **Multi-update streaming** — `SubtleCrypto.digest` is one-shot
   only.  The shim buffers all chunks until `digest()`.  For
   gigabyte-scale streaming hashes bundled OpenSSL's incremental
   state machine is more memory-efficient (policy is opt-in for this
   reason).  A streaming bridge would need either a custom wasm-side
   SHA impl or chunked deltas through a dedicated SAB data channel.
3. **Large input slot overflow** (`#!~debt e18-slot-overflow`,
   catalogued in NOTES.md) — single RPC slot caps data at ~4055 B
   post-framing.  Larger inputs throw a clear error pointing back to
   bundled OpenSSL.  Long-term fix: multi-slot chunked transfer OR a
   parallel shared-memory data channel.

## Strategic note: the pattern generalizes

E17 documented the JSPI-suspend approach as not applicable to sync
APIs.  E18 shipped the worker+sync-RPC alternative + proved it works
fast in practice (the slowest RPC was 50 µs; we previously thought
this would be ~1ms).  This pattern now generalizes:

- Any **sync Node API** that has a host **async equivalent** (Web Crypto,
  CompressionStream sync variants, etc.) can be offloaded via:
  1. Add an OP code in the `OP_DOMAIN_HOST_API` namespace.
  2. Handler in `host-worker.ts` does `await hostApi(...)`.
  3. Policy patches the Node lib to call `syncClient.callSync(...)`.

For Hmac, the cost is ~150 LOC + 1 test (we now know).

## Files changed in main

- `browser-target/src/host-worker/rpc-protocol.ts` —
  `OP_DOMAIN_HOST_API` + `OP_SUBTLE_DIGEST` with wire-format doc
- `browser-target/src/host-worker/host-worker.ts` —
  `OP_SUBTLE_DIGEST` handler
- `browser-target/src/worker.ts` — `hostRpcSyncClient` +
  `installHostDigestSyncGlobal()` + `__edgeHostDigestSync` global
- `browser-target/src/policies/crypto-hash-via-host-worker.ts` —
  new policy
- `browser-target/src/policies/index.ts` — registered policy
- `tests/js/crypto-hash-via-host-worker.{js,harness-args,stdout}` —
  new test
- `NOTES.md` — `e18-slot-overflow` debt entry
