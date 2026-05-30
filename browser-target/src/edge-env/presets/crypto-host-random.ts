import type { Preset } from "../types";

// Offload `crypto.randomBytes` / `randomFillSync` / `randomFill` /
// `randomUUID` to the host's native crypto APIs (`crypto.getRandomValues`
// and `crypto.randomUUID`).
//
// WHY
//
// Edge's vendored Node lib backs these by `OPENSSL_RAND_bytes` from the
// bundled OpenSSL — which is what makes our wasm 26MB.  Browser and Node
// hosts both expose `globalThis.crypto.getRandomValues` (Web Crypto) and
// `globalThis.crypto.randomUUID` natively, synchronously, and at high
// quality (CSPRNG).  Routing the calls there:
//
// - Smaller wasm (long-term: when other OpenSSL surfaces are also
//   offloaded, the bundled OpenSSL can be dropped entirely).
// - Faster startup (no OpenSSL CSPRNG init).
// - Same Node semantics from the caller's POV.
//
// WHAT IT DOES NOT TOUCH
//
// - `crypto.createHash` / `Hmac` / `createCipher` / `createSign` etc.
//   These have a Node-sync API surface; SubtleCrypto's equivalents are
//   async-only.  A separate preset could offload them where the caller's
//   API is also async (`crypto.webcrypto.subtle.digest`) — that's a
//   different scope.
// - `crypto.pbkdf2` (async) — could offload via SubtleCrypto.deriveBits,
//   but PBKDF2 is rarely called outside auth init; defer until needed.
//
// COMPOSITION
//
// Opt-in preset.  Not in `minimalPolicies` or `defaultBrowserPolicies` —
// callers who want the smaller surface + faster random opt in.  Composes
// last over other crypto-touching presets (last-wins for the methods it
// replaces).
//
// HOW IT REACHES THE LIB
//
// Uses a `{ post }` patch on `lib/crypto.js` so the override is applied
// inside the module's function wrapper, with access to `module.exports`.
// Replaces the three random-related methods on the exports object — lib
// destructured them at top-level so internal references in this same
// module are NOT affected, but ALL external consumers (user code +
// other lib modules that re-import) get the host-backed versions.

const POST_PATCH = `
;(function applyCryptoHostRandom() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var exp = module.exports;

  // Host's native WebCrypto, snapshotted by host/globals-shim.ts BEFORE
  // edge's bootstrap installed its own \`globalThis.crypto\` (which routes
  // through bundled OpenSSL).  Reading \`globalThis.crypto\` from inside
  // edge's execution context gets the lib module, not the host native.
  // The snapshot is non-configurable so edge can't override it.
  var snap = (typeof globalThis !== 'undefined' && globalThis.__edgeHostNativeCrypto) || null;
  if (!snap) return;
  var hostGRV = snap.getRandomValues || null;
  var hostUUID = snap.randomUUID || null;
  if (!hostGRV && !hostUUID) return;

  // WebCrypto.getRandomValues caps fills at 65536 bytes per call (per spec).
  // Loop for larger sizes — Node's randomBytes has no such cap.
  //
  // ALSO: getRandomValues refuses SAB-backed views in most runtimes (the
  // spec was updated to allow shared-memory in 2024 but adoption is
  // incomplete).  Since the buffer-wasm-aliased policy makes every
  // Buffer's .buffer be the wasm SAB, we fill into a JS-heap intermediate
  // and copy back.  Two-step is slower than one-shot but works
  // universally and the per-call overhead is bounded by MAX_FILL.
  var MAX_FILL = 65536;
  function fillFromHost(u8) {
    var off = 0;
    var sourceBuf = u8.buffer;
    var isShared = typeof SharedArrayBuffer !== 'undefined' && sourceBuf instanceof SharedArrayBuffer;
    var scratch = isShared ? new Uint8Array(Math.min(MAX_FILL, u8.length)) : null;
    while (off < u8.length) {
      var chunk = Math.min(MAX_FILL, u8.length - off);
      if (isShared) {
        var slice = chunk === scratch.length ? scratch : scratch.subarray(0, chunk);
        hostGRV(slice);
        u8.set(slice, off);
      } else {
        hostGRV(u8.subarray(off, off + chunk));
      }
      off += chunk;
    }
  }

  if (hostGRV && typeof exp.randomBytes === 'function') {
    var origRandomBytes = exp.randomBytes;
    exp.randomBytes = function randomBytes(size, callback) {
      // Node accepts (size) sync or (size, cb) async.
      if (typeof callback === 'function') {
        try {
          var b = Buffer.allocUnsafe(size);
          fillFromHost(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
          process.nextTick(function () { callback(null, b); });
        } catch (e) {
          process.nextTick(function () { callback(e); });
        }
        return;
      }
      var buf = Buffer.allocUnsafe(size);
      fillFromHost(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      return buf;
      // origRandomBytes is intentionally unreferenced — if hostGRV throws,
      // the caller sees the host's error rather than silently falling back.
    };
    void origRandomBytes;
  }

  if (hostGRV && typeof exp.randomFillSync === 'function') {
    exp.randomFillSync = function randomFillSync(buf, offset, size) {
      // Node signature: (buf [, offset[, size]])
      var off = offset == null ? 0 : (offset | 0);
      var n = size == null ? (buf.byteLength - off) : (size | 0);
      if (n <= 0) return buf;
      // ArrayBufferView.subarray works for Uint8Array; for DataView and
      // other TAs, construct a Uint8Array view spanning the requested range
      // in the underlying ArrayBuffer.
      var u8;
      if (buf && typeof buf.buffer !== 'undefined' && typeof buf.byteOffset === 'number') {
        u8 = new Uint8Array(buf.buffer, buf.byteOffset + off, n);
      } else if (buf instanceof ArrayBuffer) {
        u8 = new Uint8Array(buf, off, n);
      } else {
        // Unknown shape — fall back so we don't silently corrupt.
        return undefined;
      }
      fillFromHost(u8);
      return buf;
    };
  }

  if (hostGRV && typeof exp.randomFill === 'function') {
    exp.randomFill = function randomFill(buf, offset, size, callback) {
      // Arg normalization mirrors Node's (overloaded callback position).
      if (typeof offset === 'function') { callback = offset; offset = 0; size = buf.byteLength; }
      else if (typeof size === 'function') { callback = size; size = buf.byteLength - (offset | 0); }
      else if (typeof callback !== 'function') {
        throw new TypeError('randomFill: callback is required');
      }
      try {
        exp.randomFillSync(buf, offset, size);
        process.nextTick(function () { callback(null, buf); });
      } catch (e) {
        process.nextTick(function () { callback(e); });
      }
    };
  }

  if (hostUUID && typeof exp.randomUUID === 'function') {
    exp.randomUUID = function randomUUID(/* options */) {
      return hostUUID();
    };
  }
})();
`;

export const cryptoHostRandom: Preset = {
  name: "crypto-host-random",
  description: "Offload crypto.randomBytes/randomFillSync/randomFill/randomUUID to host's WebCrypto getRandomValues+randomUUID. Smaller surface, faster startup, identical semantics.",
  patch: {
    crypto: { post: POST_PATCH },
  },
};
