# E17: crypto.createHash via SubtleCrypto + JSPI-suspend — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a897742ce779a4dd9` (port 5192)
**Result:** **JSPI-suspend approach does NOT work for sync `digest()`.**
Strong negative finding: the JSPI / globals-shim pattern works for
async-by-default Node APIs (gzip callback, pbkdf2 callback) but NOT
for sync-by-default ones (createHash, Hmac).  Recommendation: worker
+ sync-RPC alternative (separate future work).

## What was tried

A `crypto-hash-via-subtle` policy that `{post}`-patches `lib/crypto.js`
to replace `module.exports.createHash` with a `HashShim`:
- `update(data)` buffers chunks into JS-heap `Uint8Array`s.
- `digest(enc)` calls `hostSubtle.digest(algo, combined).then(buf =>
  Buffer.from(...).toString(enc))` and returns the resulting Promise.

Host SubtleCrypto reached via the existing
`__edgeHostNativeCryptoSubtle` snapshot from E14.

## Per-test verdict

Probe: `console.log('type:', typeof r); console.log('toString:',
String(r));` where `r = c.createHash('sha256').update('hello').digest('hex')`.

| Probe | Result | Verdict |
|---|---|---|
| BASELINE (no policy) | `type: string`, expected SHA-256 hex | PASS (bundled OpenSSL) |
| SPIKE (policy on) | `type: object`, `toString: [object Promise]` | **FAIL — sync contract broken** |
| SPIKE async (user `await`s) | bit-exact SHA-256 hex matches bundled OpenSSL | Promise resolves correctly under JSPI, but doesn't help: `crypto-sha256.js` is `console.log(...digest('hex'))` — sync. |

## Why it didn't work

The sync API contract on `Hash.prototype.digest(enc) → string|Buffer`
is load-bearing.  JSPI does NOT close this gap:

1. **JSPI suspends WASM frames, not JS frames.**
   `WebAssembly.Suspending` only fires when wasm calls a Suspending-
   wrapped host import (e.g. `poll_oneoff`).  V8 is hosted *inside*
   the edge wasm; when V8 JS code calls `subtle.digest(...)`, V8
   stays in V8 — schedules a microtask on its own queue — no wasm
   frame exists to suspend.
2. **Microtask drain is wasm-driven.**  V8 microtasks only drain when
   wasm calls `unofficial_napi_process_microtasks`, which happens on
   main-loop turns.  A sync JS function can't stall its own frame
   waiting for a microtask without an `await`, and `await` requires
   the function be `async`, which means it returns a Promise.
3. **Empirically confirmed**: the SubtleCrypto Promise DOES resolve
   correctly during `_start` (JSPI-aware `poll_oneoff` suspends →
   microtasks drain → Promise settles).  But the caller's sync
   evaluation `digest('hex')` is already past that frame by then.

## Broader pattern lesson

The globals-shim / JSPI pattern works when the user-facing Node API
is itself async (callback or Promise-returning):

| API | Returns | Pattern works? |
|---|---|---|
| `zlib.gzip(buf, cb)` | callback | ✓ — E11 ships |
| `crypto.pbkdf2(...,cb)` | callback | ✓ — E14 ships |
| `WebAssembly.compile(bytes)` | Promise | ✓ — E12 ships |
| `crypto.createHash().digest()` | sync string | ✗ — E17 fails |
| `crypto.Hmac.digest()` | sync string | ✗ (same gap) |
| `crypto.createHash().update(...)` | sync (no return value) | mostly ok if we only stream — but digest() still needs sync |

The fix shape for the sync class is fundamentally different — a
worker + sync-RPC architecture, not JSPI-suspend.

## Recommendation: worker + sync-RPC alternative

E14 FINDINGS option 2.  All foundational infra exists:

- Add `OP_SUBTLE_DIGEST` op in `browser-target/src/host-worker/rpc-protocol.ts`.
- Handler in `host-worker.ts` does `await hostSubtle.digest(algo, bytes)`
  and writes the bytes to the SAB reply slot.
- Policy patches `Hash.prototype.digest` to call
  `syncClient.callSync(OP_SUBTLE_DIGEST, ...)` and return bytes
  synchronously.  Wasm thread blocks on Atomics.wait / JSPI-suspended
  `futex_wait` for ~1ms while host worker computes the digest.

New wiring is **one op + one handler + one policy**.

### Caveats for worker-RPC

- ~1ms RPC tax per `digest()` call.  For one-shot small SHA-256
  (`crypto-sha256.js` test) this is SLOWER than bundled OpenSSL.  Win
  comes for large inputs (~kB+) where SubtleCrypto's AVX-accelerated
  SHA beats bundled OpenSSL.
- Streaming `Hash extends Transform` (`_transform`/`_flush`) would
  also need routing for completeness.  Out of scope for a minimal
  first-cut.

## Open questions

1. **Hmac via the same path** —
   `SubtleCrypto.sign({name:'HMAC'}, key, data)`.  Same sync-vs-async
   gap; same worker-RPC shape applies.
2. **Memory tradeoff for streaming** — `SubtleCrypto.digest` is
   one-shot only.  `createHash().update(x).update(y).digest()` must
   buffer all chunks until `digest()` is called.  For users hashing
   large data, bundled OpenSSL's streaming state machine is more
   memory-efficient.
3. **Is the RPC cost worth it?** For most workloads, bundled OpenSSL
   is faster.  Worker-RPC variant only worth shipping if there's a
   concrete deployment where SubtleCrypto's AVX speedup dominates.

## Files in worktree (NOT in main)

- `browser-target/src/policies/crypto-hash-via-subtle.ts` — the
  broken-on-purpose spike policy (do NOT merge)
- `browser-target/src/policies/index.ts` — registered the spike
  policy (revert before merging)

These are kept in the worktree only as evidence; the FINDINGS
document is what lands in main.

## Conclusion

**Don't ship the JSPI-suspend approach for sync APIs.**  The pattern
is documented as not applicable in this FINDINGS + the broader
lesson should be encoded in future policy work: check the Node API's
sync vs async shape first; JSPI/globals-shim only works for the
already-async case.
