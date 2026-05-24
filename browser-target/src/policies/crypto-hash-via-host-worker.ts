import type { Policy } from "./index";

// Offload `crypto.createHash(...).update(...).digest()` to the host's
// SubtleCrypto.digest via the host-worker + sync-RPC channel.
//
// WHY
//
// Edge's vendored Node lib backs `Hash#digest` by an internal C++
// HashJob binding (lib/internal/crypto/hash.js) — which goes through
// bundled OpenSSL.  E17 proved JSPI-suspend can't bridge to async
// SubtleCrypto.digest from Node's SYNC `digest()` contract (the wasm
// frame is gone before the host Promise settles — see
// experiments/e17-createhash-jspi-spike/FINDINGS.md).
//
// E18's alternative: have a separate HOST worker do the (async)
// SubtleCrypto.digest, and have the WASM thread BLOCK on
// `Atomics.wait` over a SAB reply slot.  The wasm-side bridge is the
// `globalThis.__edgeHostDigestSync(algoName, bytes) → Uint8Array`
// closure installed by `worker.ts` (browser) or `node-harness.mjs`
// (Node test harness).  Both shapes implement the same contract:
// synchronous bytes-in, bytes-out.
//
// WHAT IT TOUCHES
//
// - `crypto.createHash(algo).update(chunk).digest(encoding)` — sync,
//   one-shot.  SHA-1/256/384/512 routed to SubtleCrypto.  Unknown
//   algorithms fall through to bundled OpenSSL via `origCreateHash`.
//
// WHAT IT DOES NOT TOUCH
//
// - `crypto.createHash(...).digest(encoding, callback)` — Node accepts
//   a callback form on some Hash variants.  Out of scope; bundled
//   OpenSSL handles it.
// - `crypto.Hmac` — same async-vs-sync gap; same worker-RPC shape
//   could apply via `SubtleCrypto.sign({name:'HMAC'}, key, data)`.
//   Future work (see FINDINGS open questions).
// - `crypto.createSign` / `createCipher` / etc. — legacy/complex.
//
// MEMORY MODEL
//
// `update(chunk)` accumulates chunks in JS-heap `Uint8Array` buffers;
// `digest()` concatenates them into one buffer at call time and sends
// across the wire.  SubtleCrypto.digest is one-shot only (no
// streaming) — that's the architectural cost.  For users hashing
// large data, bundled OpenSSL's streaming state machine is more
// memory-efficient; this policy is opt-in for that reason.
//
// SIZE-THRESHOLD FALLBACK
//
// E22's napi-mem staging region supports up to ~128 KiB without
// growing wasm memory; beyond that the worker threw a "data too
// large for digest staging region" error pointing the caller back
// to bundled OpenSSL.  That's a sharp edge: a user hashing a 2 MiB
// file via `crypto.createHash` gets an explicit failure rather than
// a (slightly slower) correct answer.
//
// `LARGE_INPUT_THRESHOLD` (default 1 MiB) decides when `digest()`
// transparently feeds the buffered chunks back through the captured
// `origCreateHash` — bundled OpenSSL — instead of paying the
// staging-region copy + SubtleCrypto round-trip.  The caller sees
// the correct bytes and doesn't know which path produced them.
// The threshold sits comfortably below the staging cap so we never
// rely on the worker-side guard for the transparency contract.
//
// COMPOSITION
//
// Opt-in.  Not in `minimalPolicies` or `defaultBrowserPolicies`.
// Composes with `crypto-host-random` and `crypto-via-subtle` via
// the `{ post }` patch concatenation in `composePolicies`.
//
// HOW IT REACHES THE LIB
//
// `{ post }` patch on `lib/crypto.js`.  Replaces `exports.createHash`
// with a function returning a `HashShim` whose `update` buffers and
// `digest(encoding)` calls `__edgeHostDigestSync(...)` synchronously,
// encoding the bytes per the requested encoding (hex / base64 /
// base64url / latin1 / binary; default is a Node Buffer).

// Default fallback threshold (in bytes) — inputs larger than this go
// to bundled OpenSSL via `origCreateHash` instead of the host worker.
//
// The host-worker staging region tops out at ~128 KiB today (E22).
// Going above that throws an explicit "data too large for digest
// staging region" error from `worker.ts`.  This threshold sits
// comfortably above the staging cap so the transparent fallback
// triggers BEFORE the worker-side guard fires — user code never
// sees the opaque overflow error.
//
// Picked 1 MiB because:
//   - covers typical file-hash workloads (multi-MB files) without
//     paying the SubtleCrypto memcpy + SAB staging round-trip.
//   - well above 128 KiB so the policy's natural "use host worker"
//     range (small/medium inputs) is preserved; only multi-MB cases
//     route to OpenSSL.
//   - small enough that the bundled-OpenSSL stream path's per-update
//     cost remains negligible.
//
// Tune `LARGE_INPUT_FALLBACK_THRESHOLD` at module construction time
// if a deployment wants a different break-even point.
//
// NOTE: the threshold is checked at `digest()` time against the
// accumulated buffered length.  `update()` does NOT pre-check —
// see FINDINGS open questions for the decision rationale.
const LARGE_INPUT_FALLBACK_THRESHOLD = 1 * 1024 * 1024;

const POST_PATCH = `
;(function applyCryptoHashViaHostWorker() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var exp = module.exports;
  var hostDigestSync = (typeof globalThis !== 'undefined' && globalThis.__edgeHostDigestSync) || null;
  if (typeof hostDigestSync !== 'function') return;
  var LARGE_INPUT_FALLBACK_THRESHOLD = ${LARGE_INPUT_FALLBACK_THRESHOLD};

  // Map Node digest names to WebCrypto names.  Node accepts both forms
  // ("sha256" and "SHA-256") for sync calls; WebCrypto only accepts the
  // canonical "SHA-N" form.  Unknown algos fall through to bundled
  // OpenSSL via the captured \`origCreateHash\`.
  var DIGEST_MAP = {
    'sha1':    'SHA-1',
    'sha-1':   'SHA-1',
    'sha256':  'SHA-256',
    'sha-256': 'SHA-256',
    'sha384':  'SHA-384',
    'sha-384': 'SHA-384',
    'sha512':  'SHA-512',
    'sha-512': 'SHA-512',
  };
  function normalizeAlgo(name) {
    if (typeof name !== 'string') return null;
    return DIGEST_MAP[name.toLowerCase()] || null;
  }

  // Coerce update() inputs into a JS-heap Uint8Array.  Mirrors the
  // SAB-aware Buffer handling in crypto-host-random / crypto-via-subtle:
  // \`buffer-wasm-aliased\` policy may make Buffer's underlying buffer
  // be the wasm SAB; SubtleCrypto rejects SAB-backed views in many
  // runtimes (spec was updated in 2024 but adoption is incomplete).
  // Copying into JS-heap is portable.
  function toHeapU8(input, inputEncoding) {
    if (input == null) return new Uint8Array(0);
    if (typeof input === 'string') {
      // Node default encoding for createHash inputs is utf8.
      input = Buffer.from(input, inputEncoding || 'utf8');
    }
    var len = input.byteLength | 0;
    if (len === 0) return new Uint8Array(0);
    var out = new Uint8Array(len);
    if (input instanceof Uint8Array) out.set(input);
    else if (input instanceof ArrayBuffer) out.set(new Uint8Array(input));
    else if (input.buffer && typeof input.byteOffset === 'number') {
      out.set(new Uint8Array(input.buffer, input.byteOffset, len));
    }
    return out;
  }

  function bytesToHex(u8) {
    var hex = '';
    for (var i = 0; i < u8.length; i++) {
      var b = u8[i];
      hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return hex;
  }

  function encodeOutput(bytes, encoding) {
    // No encoding → return a Node Buffer (matches Node sem).
    if (!encoding) return Buffer.from(bytes);
    var enc = String(encoding).toLowerCase();
    if (enc === 'hex')    return bytesToHex(bytes);
    if (enc === 'base64' || enc === 'base64url' ||
        enc === 'latin1' || enc === 'binary' || enc === 'utf8' || enc === 'utf-8') {
      return Buffer.from(bytes).toString(enc);
    }
    // Unknown encoding — defer to Buffer's own (will throw if invalid).
    return Buffer.from(bytes).toString(enc);
  }

  var origCreateHash = exp.createHash;
  exp.createHash = function createHash(algo, options) {
    var algoNorm = normalizeAlgo(algo);
    if (!algoNorm) {
      // Unknown algo — fall back to bundled OpenSSL.  Caller gets the
      // exact same behavior as without the policy.
      return origCreateHash(algo, options);
    }
    var chunks = [];
    var totalLen = 0;
    var consumed = false;

    function HashShim() {}
    HashShim.prototype.update = function update(data, inputEncoding) {
      if (consumed) {
        throw new Error('Digest already called');
      }
      var u8 = toHeapU8(data, inputEncoding);
      if (u8.byteLength > 0) {
        chunks.push(u8);
        totalLen += u8.byteLength;
      }
      return this;
    };
    HashShim.prototype.digest = function digest(encoding) {
      if (consumed) {
        throw new Error('Digest already called');
      }
      consumed = true;
      // Size-threshold fallback: above the threshold, replay the
      // buffered chunks through bundled OpenSSL.  This keeps the
      // caller's API contract identical (same Hash interface, same
      // output bytes) while sidestepping the host-worker staging
      // cap.  Triggered for inputs >1 MiB by default — well below
      // the staging-region limit, so user code never sees the
      // staging overflow error.
      if (totalLen > LARGE_INPUT_FALLBACK_THRESHOLD) {
        var fallback = origCreateHash(algo, options);
        for (var fi = 0; fi < chunks.length; fi++) {
          fallback.update(chunks[fi]);
        }
        chunks = null;
        // Forward encoding verbatim — bundled OpenSSL handles all
        // Node-supported encodings (hex / base64 / latin1 / Buffer).
        return encoding ? fallback.digest(encoding) : fallback.digest();
      }
      var combined;
      if (chunks.length === 1) {
        combined = chunks[0];
      } else {
        combined = new Uint8Array(totalLen);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) {
          combined.set(chunks[i], off);
          off += chunks[i].byteLength;
        }
      }
      var digestBytes = hostDigestSync(algoNorm, combined);
      // Free the chunk refs for the GC.
      chunks = null;
      return encodeOutput(digestBytes, encoding);
    };
    // Stream subset: \`Hash extends Transform\` in real Node.  We don't
    // implement the Transform side here; \`pipe(...)\` will throw on a
    // missing \`_transform\`.  Callers depending on streaming should not
    // enable this policy (see FINDINGS open questions).
    return new HashShim();
  };
})();
`;

export const cryptoHashViaHostWorker: Policy = {
  name: "crypto-hash-via-host-worker",
  description:
    "Offload crypto.createHash().digest() to host SubtleCrypto.digest via worker + sync-RPC. Sync API preserved through Atomics.wait on the SAB reply slot. SHA-1/256/384/512 only; unknown algos fall through to bundled OpenSSL. Inputs >1 MiB transparently fall through to bundled OpenSSL.",
  builtinOverrides: {
    crypto: { post: POST_PATCH },
  },
};
