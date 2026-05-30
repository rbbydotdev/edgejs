// Pre-patch on lib/buffer.js: replace internalBinding('buffer').copy
// with a JS impl that uses V8's TypedArray.prototype.set() — which
// honors source AND target byteOffset transparently.
//
// THE BUG
//
// Edge's wasm-side `_copy` doesn't correctly handle a target with a
// non-zero `byteOffset` under our wasm-aliased Buffer model.  In stock
// Node every Buffer has its own dedicated ArrayBuffer so byteOffset is
// always 0; under our model every Buffer shares the wasm SAB and
// byteOffset points into wasm memory.  When the wasm `_copy` writes
// `target_data_ptr + targetStart`, it loses the offset information and
// the bytes land in the wrong place.
//
// SURFACES IN test-buffer-copy.js:209 (the closing brace of the block
// starting at line 198) — copying b's first 512 bytes into d (a
// Uint8Array view of c) leaves d's bytes equal to whatever d was filled
// with BEFORE the copy.  The assertion `d[i] === b[i]` fails because
// the bytes never landed.
//
// THE FIX
//
// V8's TypedArray.prototype.set(source, offset) correctly honors source's
// byteOffset (when extracting bytes) and target's byteOffset (when
// writing them).  Doing the copy in JS via .set() sidesteps the wasm
// binding entirely — and lib/buffer.js's destructure picks up our
// patched binding because we run pre-body.
//
// We MUST install before lib/buffer.js's top-of-module destructure runs
// (line 62: `copy: _copy`).  Pre-patch ordering guarantees this.

;(function patchBufferCopy() {
  if (typeof internalBinding !== "function") return;
  var b;
  try { b = internalBinding("buffer"); } catch (_e) { return; }
  if (!b) return;
  if (b.__edgeCopyPatched) return;

  // Signature matches edge's wasm `_copy`:
  //   _copy(source, target, targetStart, sourceStart, nb) → nb
  // source and target are TypedArrays (Buffer extends Uint8Array).
  //
  // targetStart is a BYTE-level offset (Node's documented semantic),
  // NOT element-level.  When target is e.g. a Uint16Array, calling
  // target.set(source) directly would interpret the source bytes as
  // Uint16 elements (one-byte-source → low-byte-of-Uint16).  We need a
  // Uint8-view of the target's underlying buffer at the right
  // byteOffset, then byte-copy through that.
  function jsCopy(source, target, targetStart, sourceStart, nb) {
    if (nb <= 0) return 0;
    var sourceView = source instanceof Uint8Array
      ? source.subarray(sourceStart, sourceStart + nb)
      : new Uint8Array(source.buffer, source.byteOffset + sourceStart, nb);
    var targetU8 = target instanceof Uint8Array
      ? target
      : new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
    targetU8.set(sourceView, targetStart);
    return nb;
  }

  try {
    Object.defineProperty(b, "copy", {
      configurable: true, writable: true, value: jsCopy,
    });
    Object.defineProperty(b, "__edgeCopyPatched", {
      configurable: true, writable: true, value: true,
    });
  } catch (_e) {
    b.copy = jsCopy;
    b.__edgeCopyPatched = true;
  }
})();
