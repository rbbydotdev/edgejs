import type { Policy } from "./index";

// Offload `crypto.createHmac(algo, key).update(...).digest()` to the
// host's SubtleCrypto.importKey + SubtleCrypto.sign via the host-worker
// + sync-RPC channel.
//
// WHY
//
// Edge's vendored Node lib backs `Hmac#digest` by an internal C++
// HmacJob binding (lib/internal/crypto/mac.js) — which goes through
// bundled OpenSSL.  Same async-vs-sync gap as E18's createHash —
// SubtleCrypto.sign is Promise-shaped, Node's `Hmac.digest()` is sync.
// We reuse E18's worker+sync-RPC pattern: the wasm thread parks on
// `Atomics.wait` while the host worker awaits subtle.sign(...) and
// writes the bytes to the reply slot.
//
// WHAT IT TOUCHES
//
// - `crypto.createHmac(algo, key).update(chunk).digest(encoding)` — sync,
//   one-shot.  SHA-1/256/384/512 routed to SubtleCrypto.  Unknown algos
//   fall through to bundled OpenSSL via `origCreateHmac`.
//
// WHAT IT DOES NOT TOUCH
//
// - `crypto.createHmac(...).digest(encoding, callback)` — Node accepts
//   a callback form on some Hmac variants.  Out of scope; bundled
//   OpenSSL handles it.
// - KeyObject / CryptoKey inputs to `createHmac` — first cut supports
//   string + Buffer (the common case).  KeyObject/CryptoKey fall
//   through to bundled OpenSSL.  Future work: extract raw bytes from
//   a KeyObject before forwarding to the host.
// - Streaming `Hmac.update(...)` over gigabyte inputs — SubtleCrypto.sign
//   is one-shot only.  Same architectural cost as the digest policy;
//   `update()` buffers all chunks in JS heap until `digest()`.
//
// MEMORY MODEL
//
// `update(chunk)` accumulates chunks in JS-heap `Uint8Array` buffers;
// `digest()` concatenates them into one buffer at call time and sends
// across the wire.  SubtleCrypto.sign is one-shot only (no streaming).
// For users computing MACs over large data, bundled OpenSSL's streaming
// state machine is more memory-efficient; this policy is opt-in for
// that reason.
//
// COMPOSITION
//
// Opt-in.  Not in `minimalPolicies` or `defaultBrowserPolicies`.
// Composes with `crypto-hash-via-host-worker` and the other crypto
// policies via the `{ post }` patch concatenation in `composePolicies`.
//
// HOW IT REACHES THE LIB
//
// `{ post }` patch on `lib/crypto.js`.  Replaces `exports.createHmac`
// with a function returning an `HmacShim` whose `update` buffers and
// `digest(encoding)` calls `__edgeHostHmacSync(...)` synchronously,
// encoding the bytes per the requested encoding (hex / base64 /
// base64url / latin1 / binary; default is a Node Buffer).

const POST_PATCH = `
;(function applyCryptoHmacViaHostWorker() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var exp = module.exports;
  var hostHmacSync = (typeof globalThis !== 'undefined' && globalThis.__edgeHostHmacSync) || null;
  if (typeof hostHmacSync !== 'function') return;

  // Map Node digest names to WebCrypto names.  Node accepts both forms
  // ("sha256" and "SHA-256") for sync calls; WebCrypto only accepts the
  // canonical "SHA-N" form.  Unknown algos fall through to bundled
  // OpenSSL via the captured \`origCreateHmac\`.
  var HMAC_HASH_MAP = {
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
    return HMAC_HASH_MAP[name.toLowerCase()] || null;
  }

  // Coerce key inputs to a JS-heap Uint8Array.  Supports string +
  // Buffer/Uint8Array; KeyObject and CryptoKey fall through to bundled
  // OpenSSL (see policy file for rationale).  Returns null for unsupported
  // shapes so caller can opt out cleanly.
  function keyToHeapU8(key) {
    if (typeof key === 'string') {
      return new Uint8Array(Buffer.from(key, 'utf8'));
    }
    if (key && typeof key === 'object') {
      // Plain Buffer / Uint8Array path — copy out of any SAB-backed view.
      if (key instanceof Uint8Array) {
        var out = new Uint8Array(key.byteLength);
        out.set(key);
        return out;
      }
      if (key instanceof ArrayBuffer) {
        return new Uint8Array(key.slice(0));
      }
      // Anything else (KeyObject, CryptoKey, ...) — let the original
      // implementation handle it.
      return null;
    }
    return null;
  }

  // Coerce update() inputs into a JS-heap Uint8Array.  Same shape as
  // crypto-hash-via-host-worker; \`buffer-wasm-aliased\` policy can put
  // Buffers' backing store in the wasm SAB, which SubtleCrypto rejects
  // in many runtimes.  Copy keeps it portable.
  function toHeapU8(input, inputEncoding) {
    if (input == null) return new Uint8Array(0);
    if (typeof input === 'string') {
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
    if (!encoding) return Buffer.from(bytes);
    var enc = String(encoding).toLowerCase();
    if (enc === 'hex')    return bytesToHex(bytes);
    if (enc === 'base64' || enc === 'base64url' ||
        enc === 'latin1' || enc === 'binary' || enc === 'utf8' || enc === 'utf-8') {
      return Buffer.from(bytes).toString(enc);
    }
    return Buffer.from(bytes).toString(enc);
  }

  var origCreateHmac = exp.createHmac;
  exp.createHmac = function createHmac(algo, key, options) {
    var algoNorm = normalizeAlgo(algo);
    var keyBytes = keyToHeapU8(key);
    if (!algoNorm || !keyBytes) {
      // Unknown algo or non-(string|Buffer) key — fall back to bundled
      // OpenSSL.  Caller gets the exact same behavior as without the policy.
      return origCreateHmac(algo, key, options);
    }
    var chunks = [];
    var totalLen = 0;
    var consumed = false;

    function HmacShim() {}
    HmacShim.prototype.update = function update(data, inputEncoding) {
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
    HmacShim.prototype.digest = function digest(encoding) {
      if (consumed) {
        throw new Error('Digest already called');
      }
      consumed = true;
      var combined;
      if (chunks.length === 0) {
        combined = new Uint8Array(0);
      } else if (chunks.length === 1) {
        combined = chunks[0];
      } else {
        combined = new Uint8Array(totalLen);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) {
          combined.set(chunks[i], off);
          off += chunks[i].byteLength;
        }
      }
      var macBytes = hostHmacSync(algoNorm, keyBytes, combined);
      // Free the chunk + key refs for the GC.
      chunks = null;
      keyBytes = null;
      return encodeOutput(macBytes, encoding);
    };
    // Stream subset: \`Hmac extends Transform\` in real Node.  We don't
    // implement the Transform side; \`pipe(...)\` will throw on a missing
    // \`_transform\`.  Callers depending on streaming should not enable
    // this policy.
    return new HmacShim();
  };
})();
`;

export const cryptoHmacViaHostWorker: Policy = {
  name: "crypto-hmac-via-host-worker",
  description:
    "Offload crypto.createHmac().digest() to host SubtleCrypto.sign({name:'HMAC'}) via worker + sync-RPC. Sync API preserved through Atomics.wait on the SAB reply slot. SHA-1/256/384/512 only; unknown algos and KeyObject/CryptoKey keys fall through to bundled OpenSSL.",
  builtinOverrides: {
    crypto: { post: POST_PATCH },
  },
};
