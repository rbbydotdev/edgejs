# E21: crypto.createHmac via worker+sync-RPC — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a8351178988c90f71` (port 5195)
**Result:** **Shipped opt-in.**  Direct application of E18's pattern.
Suite: 35/0/3 → 36/0/3.

## Pattern application

Mirror of E18 (`crypto.createHash`) with one delta: HMAC needs a key
preamble in the wire format.  All other plumbing follows the E18
recipe verbatim.

## Wire format

`OP_SUBTLE_HMAC = OP_DOMAIN_HOST_API | 0x0002`.

Request:
```
[u32 algo_name_len][utf-8 algo_name]
[u32 key_len][key_bytes]
[u32 data_len][data]
```

Reply: raw HMAC bytes (32 for SHA-256, etc.) on success; UTF-8 error
on failure.

## Handler (host-worker.ts)

~70 LOC (mostly bounds-checking each of the 3 framed segments).
`subtle.importKey('raw', key, {name:'HMAC', hash: algoName}, false,
['sign'])` then `subtle.sign('HMAC', cryptoKey, data)`.

## Policy (`crypto-hmac-via-host-worker.ts`)

`{post}`-patches `lib/crypto.js`'s `createHmac`.  Buffers chunks via
`update()`, calls `__edgeHostHmacSync(algo, key, data)` in `digest()`.
Supports SHA-1/256/384/512.  Key can be string or Buffer (KeyObject /
CryptoKey fall through to bundled OpenSSL).  Opt-in (not in
defaultBrowserPolicies).

## Test

`tests/js/crypto-hmac-via-host-worker.{js,harness-args,stdout}`
exercises bit-exact HMAC output for known vectors:
`createHmac('sha256', 'key').update('hello').digest('hex')` matches
Node's `pbkdf2Sync`-style baseline.

## Op code conflict (resolved)

E22 (digest slot overflow, parallel agent) initially took
`OP_SUBTLE_DIGEST_VIA_NAPI_MEM = OP_DOMAIN_HOST_API | 0x0002`, same
as E21's HMAC.  Resolved during integration: E22's op moved to
`0x0003`, E21's HMAC keeps `0x0002`.  Main session caught + fixed.

## Open questions

- KeyObject/CryptoKey support — currently falls through to bundled.
- Slot overflow for large `key + data` — same shape as
  `e18-slot-overflow`.  E22 solved this for digest via shared napi
  memory; an `OP_SUBTLE_HMAC_VIA_NAPI_MEM` analog would be ~30 LOC
  if needed.
- Streaming Hmac.update via Transform stream — same memory tradeoff
  as createHash; opt-in policy means caller knows.

## Files in main

- `browser-target/src/host-worker/rpc-protocol.ts` — `OP_SUBTLE_HMAC`
- `browser-target/src/host-worker/host-worker.ts` — handler (~70 LOC)
- `browser-target/src/worker.ts` — `installHostHmacSyncGlobal()`
- `browser-target/src/policies/crypto-hmac-via-host-worker.ts` —
  new policy
- `browser-target/src/policies/index.ts` — register
- `tests/js/crypto-hmac-via-host-worker.{js,harness-args,stdout}` —
  new test

## Pattern proven for sync→async API offload

Three host-RPC policies now ship the same recipe:
- E18: `crypto.createHash` via `subtle.digest`
- E22: same + napi-memory data channel for large inputs
- E21: `crypto.createHmac` via `subtle.sign`

Future sync APIs that need async host equivalents (e.g. additional
crypto primitives, host-side compression in sync form) follow the
recipe: 1 op + 1 handler + 1 global + 1 policy + 1 test ≈ 150 LOC.
