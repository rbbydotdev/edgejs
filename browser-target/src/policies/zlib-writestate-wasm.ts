import type { Policy } from "./index";

// E15: bundled wasm zlib's async path crashed with
// `ERR_INTERNAL_ASSERTION: have should not go down` because the small
// `_writeState = new Uint32Array(2)` in lib/zlib.js is JS-heap, not
// wasm-aliased.  emnapi lazily allocates a wasm-side mirror for the
// JS-heap typed array; subsequent C++ writes go to that mirror, but JS
// reads come from the JS-heap copy, which lags one completion behind.
// See experiments/e13-zlib-crash-debug/FINDINGS.md for the full chain.
//
// FIX SHAPE — Option 1 from E13
//
// Patch lib/zlib.js so `_writeState` is allocated from wasm memory via
// `internalBinding('buffer').createUnsafeArrayBuffer(8)` (already
// wasm-backed under the `buffer-wasm-aliased` policy).  Then the
// emnapi `getViewPointer` fast-path takes over — `view.buffer ===
// wasmMemory.buffer`, no mirror, no sync, JS and wasm share the same
// 8 bytes.  C++ writes via the wasm pointer; JS reads via the same.
//
// The patch hooks each binding's `init` to swap the typed-array
// argument with a wasm-backed twin.  C++ stores its `napi_ref` to the
// twin (so subsequent `napi_get_typedarray_info` calls resolve to the
// twin's wasm address).  We ALSO replace the local `Zlib`/`Brotli`
// constructors so that the JS-side `this._writeState` reference picks
// up the twin (otherwise JS reads from the JS-heap original).
//
// For Zstd — `ZstdCompress`/`ZstdDecompress` extend a local `Zstd`
// class via `extends Zstd`; reassigning `Zstd` post-hoc would not
// affect the subclasses (class declarations capture the parent at
// declaration time).  Instead we wrap `module.exports.ZstdCompress`
// and `module.exports.ZstdDecompress`, plus the convenience methods
// (`gzip`, `deflate`, etc.) which use the LOCAL constructors via
// closure.  The convenience methods are RE-CREATED here via the
// already-wrapped local constructors.
//
// COMPOSITION
//
// Depends on `buffer-wasm-aliased` (which makes
// `createUnsafeArrayBuffer` return a wasm-backed Uint8Array view).
// Without it, this policy degrades to a no-op (we detect the
// fallback path and don't swap).
//
// Listed in `minimalPolicies` because the alternative (the
// `compression-via-compressionstream` policy) only covers async
// gzip/gunzip/deflate/inflate — direct stream usage of `createGzip`
// etc. still flows through bundled zlib and hits the same crash.

const POST_PATCH = `
;(function applyZlibWriteStateWasmAliased() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var bufBinding;
  try { bufBinding = internalBinding('buffer'); } catch (_e) { return; }
  var cuab = bufBinding && bufBinding.createUnsafeArrayBuffer;
  if (typeof cuab !== 'function') return;

  // Allocate a wasm-backed Uint32Array(2) for the writeState slot.
  // Returns null on failure (e.g., createUnsafeArrayBuffer didn't
  // return a view — buffer-wasm-aliased policy not active).
  function makeWasmWriteState() {
    var u8;
    try { u8 = cuab(8); } catch (_e) { return null; }
    if (!u8 || !ArrayBuffer.isView(u8)) return null;
    // Zero the 8 bytes — Node's Uint32Array(2) starts as [0, 0].
    new Uint8Array(u8.buffer, u8.byteOffset, 8).fill(0);
    return new Uint32Array(u8.buffer, u8.byteOffset, 2);
  }

  // Wrap binding.<Kind>.prototype.init so the typed-array arg at
  // \`stateIdx\` is replaced with a wasm-backed twin BEFORE the
  // original init runs.  C++ stores its napi_ref to the twin via
  // \`StoreWriteResultRef\`.  We also stash the twin on the handle so
  // the outer constructor can pick it up.
  function wrapBindingInit(BindingCtor, stateIdx) {
    if (typeof BindingCtor !== 'function') return;
    var proto = BindingCtor.prototype;
    if (!proto || typeof proto.init !== 'function' || proto.init.__edgeWrappedInit) return;
    var orig = proto.init;
    function patchedInit() {
      var args = new Array(arguments.length);
      for (var i = 0; i < arguments.length; i++) args[i] = arguments[i];
      var orig0 = args[stateIdx];
      if (orig0 instanceof Uint32Array && orig0.length === 2) {
        var twin = makeWasmWriteState();
        if (twin) {
          twin[0] = orig0[0]; twin[1] = orig0[1];
          args[stateIdx] = twin;
          this.__edgeWasmWriteState = twin;
        }
      }
      return orig.apply(this, args);
    }
    patchedInit.__edgeWrappedInit = true;
    proto.init = patchedInit;
  }

  if (binding) {
    wrapBindingInit(binding.Zlib, 4);
    wrapBindingInit(binding.BrotliEncoder, 1);
    wrapBindingInit(binding.BrotliDecoder, 1);
    wrapBindingInit(binding.ZstdCompress, 2);
    wrapBindingInit(binding.ZstdDecompress, 2);
  }

  // Reassign the LOCAL Zlib and Brotli functions so that:
  //   - All public subclasses (Deflate, Inflate, Gzip, Gunzip, ...,
  //     BrotliCompress, BrotliDecompress) which call
  //     \`Zlib.call(this, ...)\` / \`Brotli.call(this, ...)\` invoke our
  //     wrapper.
  //   - The wrapper picks up the wasm-backed twin from the handle and
  //     assigns it to \`this._writeState\`, overriding the JS-heap
  //     original from line 674 / 836.
  //
  // Why this works under function-declaration semantics: the
  // subclass closures resolve \`Zlib\` / \`Brotli\` lexically at call
  // time, so reassigning the binding at module scope is visible.
  // (Class declarations have different semantics — see the Zstd
  // wrapper further down.)
  if (typeof Zlib === 'function') {
    var OrigZlib = Zlib;
    Zlib = function ZlibPatched(opts, mode) {
      OrigZlib.call(this, opts, mode);
      if (this._handle && this._handle.__edgeWasmWriteState) {
        this._writeState = this._handle.__edgeWasmWriteState;
      }
    };
    // Preserve prototype chain — subclasses do
    // \`ObjectSetPrototypeOf(Foo.prototype, Zlib.prototype)\` AT
    // DECLARATION time so prototype links are already baked.  The
    // wrapper's own prototype doesn't need to be Zlib.prototype.
    Zlib.prototype = OrigZlib.prototype;
  }
  if (typeof Brotli === 'function') {
    var OrigBrotli = Brotli;
    Brotli = function BrotliPatched(opts, mode) {
      OrigBrotli.call(this, opts, mode);
      if (this._handle && this._handle.__edgeWasmWriteState) {
        this._writeState = this._handle.__edgeWasmWriteState;
      }
    };
    Brotli.prototype = OrigBrotli.prototype;
  }

  // Zstd uses class-extends, which captures the parent at class-decl
  // time — reassigning the local \`Zstd\` doesn't reach
  // ZstdCompress/ZstdDecompress.  Wrap module.exports.ZstdCompress
  // and module.exports.ZstdDecompress instead.  The convenience
  // method exports (\`zstdCompress\`, \`zstdDecompress\`, etc.) are
  // re-created at module export time from the LOCAL classes — so
  // they bypass any module.exports rewrap.  We rebuild them.
  function wrapZstd(name) {
    var Orig = module.exports[name];
    if (typeof Orig !== 'function') return;
    function Wrapped(opts) {
      if (!(this instanceof Wrapped)) return new Wrapped(opts);
      var inst = Reflect.construct(Orig, [opts], Wrapped);
      if (inst._handle && inst._handle.__edgeWasmWriteState) {
        inst._writeState = inst._handle.__edgeWasmWriteState;
      }
      return inst;
    }
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    module.exports[name] = Wrapped;
  }
  wrapZstd('ZstdCompress');
  wrapZstd('ZstdDecompress');

  // Local Gzip/Deflate/etc. closures STILL reference the OrigZlib
  // because they call \`Zlib.call(this, ...)\` — but we just
  // reassigned \`Zlib\` above, so future calls to local Gzip/Deflate
  // invoke OUR wrapped Zlib (which writes the wasm-backed twin to
  // \`this._writeState\`).  Convenience methods (\`gzip\`,
  // \`deflate\`, etc.) use these local constructors — they're
  // already correct.
  //
  // For module.exports.Gzip / Deflate / etc., they reference the SAME
  // local Gzip/Deflate functions — so consumers of \`require('zlib').Gzip\`
  // also get the wrapped behavior via the local-Zlib reassignment.
})();
`;

export const zlibWriteStateWasm: Policy = {
  name: "zlib-writestate-wasm",
  description: "Make zlib/brotli/zstd `_writeState = new Uint32Array(2)` wasm-backed so JS reads and C++ writes share storage (fixes bundled zlib's `have should not go down` assertion). Depends on buffer-wasm-aliased.",
  builtinOverrides: {
    zlib: { post: POST_PATCH },
  },
};
