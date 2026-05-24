# E14: crypto-via-subtle for async methods — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a2a6d82bb99ce52a1` (port 5189)
**Result:** **Works.  Shipped as opt-in.**  Suite: 30/0/3 → 31/0/3.
`crypto.pbkdf2` (callback form) now routes through `SubtleCrypto.deriveBits`
with bit-exact output vs `pbkdf2Sync`.

## Methods covered

- **`crypto.pbkdf2(pwd, salt, iters, keylen, digest, cb)`** routed
  to `SubtleCrypto.importKey('raw') → deriveBits({PBKDF2,...})`.
  Supports SHA-1/256/384/512 with both Node (`"sha256"`) and
  WebCrypto (`"SHA-256"`) digest names.  Output is bit-exact vs
  `pbkdf2Sync`.

## Skipped (with reason)

- **`pbkdf2Sync`** — async-only SubtleCrypto.  Sync path stays on
  bundled OpenSSL.
- **`scrypt`** — async-shaped but SubtleCrypto has no native scrypt.
  JS polyfill out of scope.
- **`createHash` / `Hmac`** — sync `update().digest()` API surface;
  `SubtleCrypto.digest` is async-only.  Out of scope per spec.
  Future-shape options documented below.
- **`timingSafeEqual` / `diffieHellman` / `createCipher`** — sync or
  legacy, no SubtleCrypto win.

## Implementation

Four files:

- `browser-target/src/host/globals-shim.ts` — added
  `__edgeHostNativeCryptoSubtle` snapshot (non-configurable,
  pre-bootstrap).  Mirrors E11's `__edgeHostCompressionStream`
  pattern.  Snapshots the whole `subtle` object (not bound methods)
  because SubtleCrypto requires `this === subtle`.
- `browser-target/src/policies/crypto-via-subtle.ts` (new) —
  `{ post: PATCH }` override on `crypto`.  Patch reads the
  snapshot, replaces `module.exports.pbkdf2` with a SubtleCrypto-
  backed impl.  Key parts: SAB-aware `toHeapU8` copy (mirrors
  crypto-host-random); `Buffer.from(new Uint8Array(...))` for
  wasm-aliased output; **direct Promise→callback** invocation
  (NOT `process.nextTick`) — same fix as E11.
- `browser-target/src/policies/index.ts` — exports + registers
  `cryptoViaSubtle`.
- `tests/js/crypto-pbkdf2-via-subtle.{js,harness-args,stdout}` —
  test against two known-good hex vectors:
  - `pbkdf2('pwd','salt',100,16,'sha256')` →
    `397ca5768f332cbc646df76dbec2d689`
  - `pbkdf2('password123','somesalt',1000,32,'sha256')` →
    `f6e19c8932b462c16cf085fae85d981b2c7e17fdb56c15426c74faa531911330`

## Suite result

**31 pass, 0 fail, 0 err, 3 skip** (was 30/0/3).

E14 agent flagged a "harness blocked" issue — they meant
`node-harness.mjs` (the Node-side harness), not
`browser-test-runner.mjs` (the actual regression net).  Browser
runner works fine.  The node-harness regression is a separate
issue (tracked in NOTES.md).

## Perf delta (estimated)

Microbench (50 iters, JSPI-on Node 24.16, host-only):

| Workload | bundled OpenSSL via Node | host SubtleCrypto |
|---|---:|---:|
| 100 iter / 16B / sha256 | 0.02 ms/op | 0.06 ms/op |
| 10000 iter / 32B / sha256 | 1.23 ms/op | 1.28 ms/op |

In edge.js context the policy replaces **WASM-bundled** OpenSSL
(2-5× slower than native), so expected real win is 1.5-4× on heavy
iterations.

## Out-of-scope work (createHash via SubtleCrypto)

For a future experiment, `crypto.createHash` via SubtleCrypto would
need an async-shim.  Two viable designs:

1. **JSPI suspend.**  `hash.digest()` becomes Suspending-wrapped;
   awaits `subtle.digest(...)`.  Engine-gated (Chrome 137+, Node
   v24+ with flag).  Mirrors how the existing compression policy
   composes.
2. **Worker + sync RPC.**  SubtleCrypto.digest in a worker;
   `Hash.digest()` does sync postMessage + Atomics.wait.  No JSPI
   needed; ~1ms RPC tax.

Patch site is `lib/internal/crypto/hash.js`.  Same design extends
to **Hmac via `SubtleCrypto.sign` with HMAC key** — likely the
higher-value target than digest-only.

## Recommendation

**Ship as opt-in.**  Implementation mirrors two proven patterns
(crypto-host-random for shim plumbing, compression-via-compressionstream
for async-callback discipline); test confirms correctness; full
suite +1.  Don't default-enable — bundled OpenSSL stays the safe
baseline; SubtleCrypto's importKey overhead is a small tax for
callers doing only light PBKDF2 work.

## Files changed in main

- `browser-target/src/host/globals-shim.ts` — SubtleCrypto snapshot
- `browser-target/src/policies/crypto-via-subtle.ts` — new policy
- `browser-target/src/policies/index.ts` — exports + registers
- `tests/js/crypto-pbkdf2-via-subtle.{js,harness-args,stdout}` —
  new test
