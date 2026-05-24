import type { Policy } from "./index";

// Offload `crypto.pbkdf2` (async callback form) to the host's
// `SubtleCrypto.deriveBits` with PBKDF2 algorithm.
//
// WHY
//
// Edge's vendored Node lib backs `pbkdf2` by an internal `PBKDF2Job` C++
// binding (lib/internal/crypto/pbkdf2.js → internalBinding('crypto').PBKDF2Job)
// — that path goes through bundled OpenSSL.  SubtleCrypto on every modern
// host (Node 15+, Chrome, Safari, Firefox) supports PBKDF2 natively with
// the same algorithm and bit-exact output.  Routing the call there:
//
// - Smaller crypto surface in the wasm (long-term: when other OpenSSL
//   surfaces are also offloaded, bundled OpenSSL can be dropped — pbkdf2
//   is one tile in that mosaic).
// - Faster startup (no OpenSSL PBKDF2 init).
// - Same Node semantics from the caller's POV — Buffer in (or any
//   ArrayBufferView), callback fires with (err, Buffer).
//
// WHAT IT DOES NOT TOUCH
//
// - `crypto.pbkdf2Sync` — SubtleCrypto is async-only.  Sync API mismatch;
//   leaves the bundled OpenSSL to handle it.  A future
//   `crypto-via-subtle-sync` policy could JSPI-suspend the sync call
//   into an async SubtleCrypto, but that's a different design.
// - `crypto.createHash` / `Hmac` — sync API surface.  Same async-only
//   mismatch as pbkdf2Sync.  SubtleCrypto.digest is async-only;
//   bridging would need an async-shim (JSPI suspend or sync RPC into
//   a Worker that does SubtleCrypto).  Out of scope for E14.
// - `crypto.scrypt` — async but SubtleCrypto has no native scrypt.
//   Would require a JS polyfill (pbkdf2-based stretching).  Out of
//   scope — bundled OpenSSL handles it correctly.
// - `crypto.createCipher` / `createSign` / etc. — legacy + complex
//   (key-object plumbing, multiple algorithms, streaming chunks).
// - `crypto.diffieHellman` / `crypto.timingSafeEqual` — mostly sync,
//   no SubtleCrypto equivalent worth the trouble.
//
// COMPOSITION
//
// Opt-in policy.  Not in `minimalPolicies` or `defaultBrowserPolicies`.
// Composes alongside `crypto-host-random` (different methods, same lib
// module — patches concatenate cleanly via the `{ post }` patch
// composition in `composePolicies`).
//
// JSPI ENABLES THIS POLICY (when hot)
//
// SubtleCrypto methods are Promise-returning.  On engines without JSPI
// (Node v22, Safari, older Firefox), Promise continuations queued in
// host async code can't resolve inside edge's `_start` loop, so the
// callback never fires there.  With JSPI (Chrome 137+, Node v24+ with
// flag) the wasi-shim's `poll_oneoff` suspends via `Atomics.waitAsync`,
// yielding the microtask queue to the engine — the host Promise chains
// resolve, the policy's callback fires.
//
// Mirrors the deployment posture of `compression-via-compressionstream`:
// only enable when the target engine supports `WebAssembly.Suspending`.
//
// HOW IT REACHES THE LIB
//
// Uses a `{ post }` patch on `lib/crypto.js` so the override is applied
// inside the module's function wrapper, with access to `module.exports`.
// Replaces `exports.pbkdf2` after the lib has finished its own setup —
// the lib destructured `pbkdf2` from `internal/crypto/pbkdf2` at
// top-level so internal references in this same module are NOT affected,
// but ALL external consumers (user code + other lib modules that
// re-import `crypto`) get the SubtleCrypto-backed version.

const POST_PATCH = `
;(function applyCryptoViaSubtle() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var exp = module.exports;

  // Use the host's NATIVE SubtleCrypto snapshotted by globals-shim BEFORE
  // edge's bootstrap exposed its OWN \`globalThis.crypto\` (whose .subtle
  // wraps the bundled OpenSSL — defeats the whole point of this policy).
  var hostSubtle = (typeof globalThis !== 'undefined' && globalThis.__edgeHostNativeCryptoSubtle) || null;
  if (!hostSubtle) return;

  // Map Node digest names to WebCrypto names.  Node accepts both forms
  // ("sha256" and "SHA-256") for sync calls, but SubtleCrypto only
  // accepts the canonical "SHA-N" form.
  var DIGEST_MAP = {
    'sha1': 'SHA-1',
    'sha-1': 'SHA-1',
    'sha256': 'SHA-256',
    'sha-256': 'SHA-256',
    'sha384': 'SHA-384',
    'sha-384': 'SHA-384',
    'sha512': 'SHA-512',
    'sha-512': 'SHA-512',
  };

  function normalizeDigest(name) {
    if (typeof name !== 'string') return null;
    var lower = name.toLowerCase();
    return DIGEST_MAP[lower] || null;
  }

  // SubtleCrypto rejects SAB-backed views in most runtimes (the spec was
  // updated to allow shared-memory in 2024 but adoption is incomplete).
  // Since the buffer-wasm-aliased policy makes every Buffer's .buffer be
  // the wasm SAB, we copy inputs into JS-heap Uint8Arrays before passing
  // them to SubtleCrypto.
  function toHeapU8(input) {
    if (input == null) return new Uint8Array(0);
    // Node accepts strings — go through Buffer.from to match Node semantics
    // (default UTF-8) and pick up the wasm-aliased Buffer for size, then
    // copy bytes into a JS-heap Uint8Array.
    if (typeof input === 'string') input = Buffer.from(input);
    var len = input.byteLength | 0;
    if (len === 0) return new Uint8Array(0);
    var out = new Uint8Array(len);
    if (input instanceof Uint8Array) {
      out.set(input);
    } else if (input instanceof ArrayBuffer) {
      out.set(new Uint8Array(input));
    } else if (input.buffer && typeof input.byteOffset === 'number') {
      out.set(new Uint8Array(input.buffer, input.byteOffset, len));
    }
    return out;
  }

  if (typeof exp.pbkdf2 === 'function') {
    exp.pbkdf2 = function pbkdf2(password, salt, iterations, keylen, digest, callback) {
      // Node accepts (password, salt, iterations, keylen, callback) when
      // digest is omitted — but defaults to undefined, which IS an error
      // in real Node.  We mirror that: require digest.
      if (typeof digest === 'function') {
        callback = digest;
        digest = undefined;
      }
      if (typeof callback !== 'function') {
        throw new TypeError('pbkdf2: callback is required');
      }

      var algo;
      try {
        var hashName = normalizeDigest(digest);
        if (!hashName) {
          // Defer the error to the callback (Node's pbkdf2 throws sync on
          // bad digest, but the SubtleCrypto path is async — easier to
          // call back with the error than to mirror the validateString
          // sync throw exactly).  Real apps treat both as a programmer
          // error, not a runtime failure.
          var err = new TypeError('pbkdf2: unsupported digest "' + String(digest) + '"');
          process.nextTick(function () { callback(err); });
          return;
        }
        if (!(iterations >= 1)) {
          var iterErr = new TypeError('pbkdf2: iterations must be >= 1');
          process.nextTick(function () { callback(iterErr); });
          return;
        }
        if (!(keylen >= 0)) {
          var lenErr = new TypeError('pbkdf2: keylen must be >= 0');
          process.nextTick(function () { callback(lenErr); });
          return;
        }
        algo = hashName;
      } catch (eArg) {
        process.nextTick(function () { callback(eArg); });
        return;
      }

      var passU8 = toHeapU8(password);
      var saltU8 = toHeapU8(salt);

      // SubtleCrypto.importKey + deriveBits.  Both return Promises; we
      // chain them and fire the callback directly off the final settle
      // (NOT through process.nextTick — see compression-via-compressionstream
      // for the rationale: a nextTick queued from inside an inner Promise
      // doesn't always drain before the outer _start runs out of work).
      try {
        hostSubtle.importKey(
          'raw',
          passU8,
          { name: 'PBKDF2' },
          false,
          ['deriveBits']
        ).then(function (key) {
          return hostSubtle.deriveBits(
            { name: 'PBKDF2', salt: saltU8, iterations: iterations | 0, hash: algo },
            key,
            (keylen | 0) * 8
          );
        }).then(function (bits) {
          // Output is an ArrayBuffer over JS-heap.  Copy into a Node
          // Buffer (via Buffer.from on a Uint8Array view) — that copy
          // goes through the wasm-aliased Buffer path so the result is
          // a real edge-compatible Buffer.
          var buf = Buffer.from(new Uint8Array(bits));
          callback(null, buf);
        }, function (subtleErr) {
          callback(subtleErr);
        });
      } catch (eOuter) {
        callback(eOuter);
      }
    };
  }
})();
`;

export const cryptoViaSubtle: Policy = {
  name: "crypto-via-subtle",
  description: "Offload crypto.pbkdf2 (async) to host SubtleCrypto.deriveBits with PBKDF2. Sync variants and createHash/Hmac/scrypt remain on bundled OpenSSL.",
  builtinOverrides: {
    crypto: { post: POST_PATCH },
  },
};
