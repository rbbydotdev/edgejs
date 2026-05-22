import type { Policy } from "./index";

// Offload `zlib.gzip` / `gunzip` / `deflate` / `inflate` / `deflateRaw` /
// `inflateRaw` (the async convenience methods) to the browser's
// `CompressionStream` / `DecompressionStream`.
//
// WHY
//
// Edge's vendored Node lib backs zlib by `node:internal/zlib/binding` →
// C++ zlib (zlib-ng), part of the bundled stack.  Browser and modern
// Node hosts expose `CompressionStream` / `DecompressionStream` natively
// for the three formats users actually want (gzip, deflate, deflate-raw).
// Routing the async one-shot helpers there:
//
// - Avoids the wasm-side zlib initialization for one-shot compress/decompress.
// - Same Node semantics from the caller's POV — Buffer in, Buffer out,
//   callback fires on next tick with (err, result).
// - Foundation for dropping the wasm-side zlib entirely once stream
//   wrappers (`createGzip` etc.) also get offloaded.
//
// WHAT IT DOES NOT TOUCH
//
// - `gzipSync` / `gunzipSync` / etc. — browser has no synchronous
//   equivalent.  Leaves the sync surface to bundled zlib.
// - `createGzip` / `createGunzip` / etc. (Transform streams) — bridging
//   Node's Transform streams to Web Streams is a meaningful chunk of
//   work; lives in a future `streams-via-web-streams` policy.
// - `brotliCompress` / `brotliDecompress` / `zstdCompress` /
//   `zstdDecompress` — no universal browser equivalent.  Brotli has
//   `CompressionStream('br')` in recent Chrome but not Safari/Firefox
//   broadly; zstd has no browser path.
//
// SAB-BACKED BUFFER NOTE
//
// Like WebCrypto.getRandomValues, browser CompressionStream's reader
// hands out Uint8Arrays over a JS-heap ArrayBuffer.  We assemble those
// chunks into a single Uint8Array, then convert to a Node Buffer via
// `Buffer.from(uint8)` — that copy goes through the wasm-aliased Buffer
// path so the result is a real edge-compatible Buffer.  Input flows the
// other direction: we copy the input Buffer's bytes into a JS-heap
// Uint8Array before writing into the stream, because some runtimes
// refuse SAB-backed views in Stream APIs.
//
// JSPI ENABLES THIS POLICY
//
// `CompressionStream` is async — `writer.write` / `writer.close` /
// `reader.read` all return Promises.  On engines without JSPI (Node
// v22, Safari, older Firefox) Promise continuations queued in host
// async code can't resolve inside edge's `_start` loop, so this
// policy's callback never fires there.  With JSPI active (Chrome 137+,
// Node v24+ with flag) the wasi-shim's poll_oneoff suspends via
// `Atomics.waitAsync`, which yields the microtask queue to the
// engine — host Promise chains resolve, this policy's callback fires.
//
// Deployment guidance: only enable when the target engine supports
// `WebAssembly.Suspending`.  The harness picks the JSPI yield strategy
// automatically when available (see `wasi-shim/yield-strategy.ts`).
//
// COMPOSITION
//
// Opt-in policy.  Not in `minimalPolicies` or `defaultBrowserPolicies`.

const POST_PATCH = `
;(function applyCompressionViaCompressionStream() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var exp = module.exports;

  var hasCS = typeof CompressionStream === 'function' &&
              typeof DecompressionStream === 'function';
  if (!hasCS) return;

  // Map zlib method name → CompressionStream/DecompressionStream format.
  // Browser supports 'gzip', 'deflate', 'deflate-raw'.  Brotli is opt-in
  // per browser; we leave the bundled zlib to handle it.
  var COMPRESS_MAP = { gzip: 'gzip', deflate: 'deflate', deflateRaw: 'deflate-raw' };
  var DECOMPRESS_MAP = { gunzip: 'gzip', inflate: 'deflate', inflateRaw: 'deflate-raw' };

  // Copy a Buffer's bytes into a fresh JS-heap Uint8Array.  Required
  // because the Buffer's backing storage is the wasm SAB, and some
  // runtimes reject SAB-backed views in Stream APIs.
  function bufferToHeapU8(buf) {
    if (!buf) return new Uint8Array(0);
    if (typeof buf === 'string') {
      // Node accepts a string + encoding for the convenience methods.
      // Default encoding is 'utf8'; we go through Buffer to match Node.
      buf = Buffer.from(buf);
    }
    var len = buf.byteLength | 0;
    if (len === 0) return new Uint8Array(0);
    var out = new Uint8Array(len);
    // \`buf\` is a Buffer (Uint8Array subclass) or a TypedArray/ArrayBuffer.
    if (buf instanceof Uint8Array) {
      out.set(buf);
    } else if (buf instanceof ArrayBuffer) {
      out.set(new Uint8Array(buf));
    } else if (buf.buffer && typeof buf.byteOffset === 'number') {
      out.set(new Uint8Array(buf.buffer, buf.byteOffset, len));
    }
    return out;
  }

  // Concatenate read chunks into a single Buffer.
  function concatChunksToBuffer(chunks, totalLen) {
    var u8 = new Uint8Array(totalLen);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) {
      u8.set(chunks[i], off);
      off += chunks[i].byteLength;
    }
    return Buffer.from(u8);
  }

  // Drive a CompressionStream / DecompressionStream end-to-end.  Returns
  // a Promise<Buffer>.  Caller bridges to nextTick(callback).
  function runStream(stream, inputU8) {
    var writer = stream.writable.getWriter();
    var reader = stream.readable.getReader();
    var chunks = [];
    var total = 0;

    function readLoop() {
      return reader.read().then(function (r) {
        if (r.done) return;
        chunks.push(r.value);
        total += r.value.byteLength;
        return readLoop();
      });
    }

    var writePromise = inputU8.byteLength
      ? writer.write(inputU8).then(function () { return writer.close(); })
      : writer.close();

    return Promise.all([writePromise, readLoop()]).then(function () {
      return concatChunksToBuffer(chunks, total);
    });
  }

  // Normalize the (buffer, options?, callback) signature.  The lib's
  // createConvenienceMethod accepts (buffer, opts, callback) where opts
  // may be omitted.
  function normalizeArgs(buffer, optsOrCb, maybeCb) {
    var opts = null;
    var cb = null;
    if (typeof optsOrCb === 'function') {
      cb = optsOrCb;
    } else {
      opts = optsOrCb || null;
      cb = maybeCb || null;
    }
    return { opts: opts, cb: cb };
  }

  function installOverride(method, kind /* 'compress' | 'decompress' */, format) {
    if (typeof exp[method] !== 'function') return;
    exp[method] = function patched(buffer, optsOrCb, maybeCb) {
      var n = normalizeArgs(buffer, optsOrCb, maybeCb);
      if (typeof n.cb !== 'function') {
        // No callback — synchronous-style call, which Node's async
        // convenience method does NOT support (it throws).  Mirror
        // that behavior so callers see Node-like errors.
        var err = new TypeError('Compression callback must be a function');
        throw err;
      }
      try {
        var input = bufferToHeapU8(buffer);
        var stream = kind === 'compress'
          ? new CompressionStream(format)
          : new DecompressionStream(format);
        runStream(stream, input).then(
          function (out) { process.nextTick(function () { n.cb(null, out); }); },
          function (e) { process.nextTick(function () { n.cb(e); }); }
        );
      } catch (eOuter) {
        process.nextTick(function () { n.cb(eOuter); });
      }
      // Lib's convenience methods return undefined when called async.
    };
  }

  for (var m in COMPRESS_MAP) { installOverride(m, 'compress', COMPRESS_MAP[m]); }
  for (var d in DECOMPRESS_MAP) { installOverride(d, 'decompress', DECOMPRESS_MAP[d]); }
})();
`;

export const compressionViaCompressionStream: Policy = {
  name: "compression-via-compressionstream",
  description: "Offload zlib.gzip/gunzip/deflate/inflate/deflateRaw/inflateRaw (async) to host CompressionStream/DecompressionStream. Sync variants and brotli/zstd remain on bundled zlib.",
  builtinOverrides: {
    zlib: { post: POST_PATCH },
  },
};
