// Post-patch on lib/buffer.js: override Buffer.from(string, "base64") /
// (string, "base64url") so it uses the vendored decoder AND allocates a
// correctly-sized buffer in one step, bypassing createFromString.
//
// WHY
//
// Two bugs collapse into one fix here:
//
// 1. The wasm-side `internalBinding('buffer').base64Write` rejects strings
//    with illegal characters (0x80, 0xff, 0x00, stray ASCII) by returning
//    zero bytes, instead of silently skipping them per RFC 4648 §3.3 / Node's
//    documented Buffer behavior.  test-buffer-alloc.js:399 fails as a
//    result — `Buffer.from(quoteWithIllegalChars, 'base64')` returns an
//    empty buffer.
//
// 2. Even with a correct decoder, lib/buffer.js's `createFromString`
//    (line 505) constructs the result via `new FastBuffer(buf.buffer, 0,
//    actual)` when `actual < length`.  That assumes `buf.byteOffset === 0`
//    — true for stock Node where every alloc gets its own ArrayBuffer.
//    UNDER OUR wasm-aliased Buffer model (see buffer-wasm-aliased preset)
//    every Buffer shares the wasm SAB and `buf.byteOffset` points at a
//    wasm-memory offset.  `new FastBuffer(buf.buffer, 0, actual)` creates
//    a view at offset ZERO of the SAB instead of at the bytes we wrote.
//    The buffer reads as all-zeros even though our decoder wrote the
//    right bytes at the right offset.
//
// THE FIX
//
// Replace `Buffer.from` for `(string, "base64"|"base64url")` only.  For
// these inputs we:
//
//   1. Call `globalThis.__edgeDecodeBase64(input)` (installed by worker.ts
//      from `src/edge-env/vendor-adapters/unenv-base64.ts`) which returns
//      a `Uint8Array` of exact decoded length.
//   2. Allocate `Buffer.allocUnsafeSlow(bytes.length)` — exact size, so
//      `createFromString` doesn't run at all.  `allocUnsafeSlow` goes
//      through `createUnsafeBuffer` → wasm-aliased view with the correct
//      `byteOffset`.
//   3. Copy bytes into the buffer.  Both `Buffer.prototype.set` (inherited
//      from Uint8Array) and indexed assignment are byteOffset-aware.
//   4. Return.
//
// All other Buffer.from inputs (Array, ArrayBuffer, Buffer, other
// encodings, single-arg string-which-defaults-to-utf8, ...) delegate to
// the original to keep behavior identical.
//
// This single patch closes both bugs without touching the closure-private
// `createFromString` or the wasm `internalBinding('buffer').base64Write`.
//
// SIDE NOTE
//
// `Buffer.prototype.write(string, offset, length, 'base64')` still goes
// through the wasm-side base64Write (which fails on illegal chars).  If
// that path needs the same tolerance, add a similar override on
// `Buffer.prototype.write` here.  Not yet needed for the failing
// corpus tests but easy to extend.

;(function patchBufferFromBase64() {
  if (typeof module === "undefined" || !module || !module.exports) return;
  if (typeof globalThis.__edgeDecodeBase64 !== "function") return;
  var Buffer = module.exports.Buffer;
  if (typeof Buffer !== "function") return;
  if (Buffer.__edgeBase64FromPatched) return;

  var origFrom = Buffer.from;
  if (typeof origFrom !== "function") return;

  var allocUnsafeSlow = Buffer.allocUnsafeSlow;
  if (typeof allocUnsafeSlow !== "function") return;

  function fromBase64(input) {
    var bytes = globalThis.__edgeDecodeBase64(input);
    var len = bytes.length;
    var buf = allocUnsafeSlow.call(Buffer, len);
    // Buffer extends Uint8Array; .set works byte-by-byte respecting
    // byteOffset on both sides — exactly what we need under wasm-aliasing.
    buf.set(bytes, 0);
    return buf;
  }

  Buffer.from = function from(value, encodingOrOffset, _length) {
    void _length;
    if (typeof value === "string"
        && (encodingOrOffset === "base64" || encodingOrOffset === "base64url")) {
      return fromBase64(value);
    }
    return origFrom.apply(this, arguments);
  };

  Buffer.__edgeBase64FromPatched = true;
})();
