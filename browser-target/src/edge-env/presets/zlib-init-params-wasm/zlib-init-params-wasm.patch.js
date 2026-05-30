// Post-patch on lib/zlib.js: replace each `init(params, ...)` call on
// brotli/zstd binding handles so the FIRST argument (a JS-heap
// Uint32Array shared across all Brotli/Zstd instances) is copied into
// a fresh wasm-backed Uint32Array before the wasm sees it.
//
// THE BUG
//
// lib/zlib.js allocates THREE module-level JS-heap Uint32Arrays at
// load time:
//   - brotliInitParamsArray   (line ~805, length kMaxBrotliParam+1)
//   - zstdInitCParamsArray    (line ~916, length kMaxZstdCParam+1)
//   - zstdInitDParamsArray    (line ~930, length kMaxZstdDParam+1)
//
// Each `new Brotli(opts, mode)` reuses the SAME `brotliInitParamsArray`:
//   1. .fill(-1) — JS writes
//   2. array[key] = value — JS writes the user's params
//   3. handle.init(brotliInitParamsArray, this._writeState, processCallback)
//
// Under our wasm-aliased Buffer model, emnapi lazily allocates a
// wasm-side mirror for a JS-heap typed array on first use.  The
// mirror's bytes are copied IN once, then subsequent JS writes don't
// reach the mirror unless re-passed through napi.  The wasm C++
// brotli init reads from the mirror — so every instance after the
// first sees the FIRST instance's params.  Result: changing
// `BROTLI_PARAM_QUALITY` between successive instances has no visible
// effect, all compressed outputs are the same size.
//
// SURFACE: test-zlib-brotli.js fails on
//   `assert(sizes[0] > sizes[sizes.length - 1], sizes)`
// because sizes is [5571, 5571, 5571, ..., 5571] (one value, repeated).
//
// THE FIX — same shape as zlib-writestate-wasm
//
// Wrap `binding.BrotliEncoder.prototype.init`,
// `binding.BrotliDecoder.prototype.init`,
// `binding.ZstdCompress.prototype.init`,
// `binding.ZstdDecompress.prototype.init` so that the FIRST argument
// (a Uint32Array) is copied into a freshly-allocated wasm-backed twin
// (via `internalBinding('buffer').createUnsafeArrayBuffer(...)`)
// before calling the original init.  Each call gets its own fresh
// wasm-backed buffer, so the wasm side reads the correct per-instance
// params.
//
// The other init args (writeState etc.) are handled by the existing
// `zlib-writestate-wasm` preset; we don't touch them here.
//
// COMPOSITION
//
// Depends on `buffer-wasm-aliased` (for `createUnsafeArrayBuffer`).
// Without it, the wrapper is a no-op (we detect the fallback and
// pass through to the original init).
//
// Composes additively with `zlib-writestate-wasm`: both wrap
// `prototype.init` on the same binding constructors.  Our wrapper
// runs first (so init params are wasm-backed when the writeState
// wrapper sees the call), the writeState wrapper runs next.  The
// ordering is enforced by the post-patch sequence in worker.ts:
// register zlib-init-params-wasm BEFORE zlib-writestate-wasm.
//
// Actually — both post-patches install themselves as
// `proto.init = patched`.  The LAST one to install becomes the
// outermost.  We need OUR wrapper to be the OUTER one so it copies
// params before any other wrapping runs, OR we need to make our
// patch idempotent and detect already-wrapped inits.  We do the
// latter: install with __edgeWrappedInitParams marker and skip on
// re-install.  See zlib-writestate-wasm for the marker pattern.

;(function applyZlibInitParamsWasmAliased() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var bufBinding;
  try { bufBinding = internalBinding('buffer'); } catch (_e) { return; }
  var cuab = bufBinding && bufBinding.createUnsafeArrayBuffer;
  if (typeof cuab !== 'function') return;

  // Allocate a wasm-backed Uint32Array of the given length.  Returns
  // null on failure (e.g., createUnsafeArrayBuffer didn't return a
  // view — buffer-wasm-aliased policy not active).
  function makeWasmUint32Array(len) {
    var byteLen = len * 4;
    var u8;
    try { u8 = cuab(byteLen); } catch (_e) { return null; }
    if (!u8 || !ArrayBuffer.isView(u8)) return null;
    // Ensure 4-byte alignment for the Uint32Array view.
    if ((u8.byteOffset & 3) !== 0) return null;
    return new Uint32Array(u8.buffer, u8.byteOffset, len);
  }

  // Wrap binding.<Kind>.prototype.init so that argument 0 (a
  // Uint32Array of init params) is replaced with a wasm-backed twin
  // BEFORE the original init runs.  The twin is fresh on every call
  // so the wasm side sees the per-instance params, not the first
  // instance's stale params.
  function wrapBindingInitForParams(BindingCtor) {
    if (typeof BindingCtor !== 'function') return;
    var proto = BindingCtor.prototype;
    if (!proto || typeof proto.init !== 'function') return;
    if (proto.init.__edgeWrappedInitParams) return;
    var orig = proto.init;
    function patchedInit() {
      var args = new Array(arguments.length);
      for (var i = 0; i < arguments.length; i++) args[i] = arguments[i];
      var params = args[0];
      if (params instanceof Uint32Array) {
        var twin = makeWasmUint32Array(params.length);
        if (twin) {
          for (var j = 0; j < params.length; j++) twin[j] = params[j];
          args[0] = twin;
        }
      }
      return orig.apply(this, args);
    }
    patchedInit.__edgeWrappedInitParams = true;
    // Preserve the __edgeWrappedInit marker from zlib-writestate-wasm
    // if it already ran — we don't want it to re-wrap.
    if (orig.__edgeWrappedInit) patchedInit.__edgeWrappedInit = true;
    proto.init = patchedInit;
  }

  if (typeof binding !== 'undefined' && binding) {
    wrapBindingInitForParams(binding.BrotliEncoder);
    wrapBindingInitForParams(binding.BrotliDecoder);
    wrapBindingInitForParams(binding.ZstdCompress);
    wrapBindingInitForParams(binding.ZstdDecompress);
  }
})();
