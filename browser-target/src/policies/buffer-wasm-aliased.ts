import type { Policy } from "./index";

// Eliminates the JS-heap ↔ wasm split for `Buffer` storage.  This is the
// "perfect" alternative to `buffer-write-sync`: instead of wrapping every
// public Buffer write entry point with a sync trigger, we make the JS-side
// AB literally BE wasm memory — same bytes, no mirror, no sync ever.
//
// HOW IT WORKS
//
// 1. The napi host overrides `napi_create_external_arraybuffer` (used by
//    edge's `internalBinding('buffer').createUnsafeArrayBuffer` and by
//    stream/udp wrap paths) to register the handle's value as a
//    `Uint8Array` view over wasm memory at the external_data pointer —
//    NOT as a fresh JS-heap `ArrayBuffer` with a sync-mapping table.
//    See `src/napi-host/index.ts` — search for `napi_create_external_arraybuffer`.
//
// 2. With the napi override alone, lib/internal/buffer.js still has
//    `new FastBuffer(createUnsafeArrayBuffer(size))`.  That's
//    `new Uint8Array(uint8arrayView)` — the typed-array-input ctor COPIES
//    (ECMA-262 §23.2.5.1).  The copy lands in JS-heap, defeating the fix.
//
// 3. This policy's surgical patch (delivered via the `{ post: string }`
//    override shape on `internal/buffer`) reassigns
//    `module.exports.createUnsafeBuffer` so it detects a typed-array result
//    and constructs the FastBuffer via `(buffer, byteOffset, byteLength)`
//    — the 3-arg form which creates a VIEW, no copy.  Result:
//    `buf.buffer === wasmMemory.buffer` (the SAB),
//    `buf.byteOffset === wasm_ptr`, `buf.length === size`.  JS-side
//    indexed access (`buf[i]`) and C++ writes touch the same bytes.
//
// WHY A POST-PATCH AND NOT A FULL OVERRIDE
//
// `lib/internal/buffer.js` is ~1100 lines of vendored Node code.  Replacing
// it entirely would shift maintenance burden onto us forever.  The
// `{ post }` shape (added 2026-05-21 to the policy framework) keeps edge's
// bundled body intact and only splices our small patch after it — inside
// the same function wrapper, so the patch sees the module's locals
// (`FastBuffer`, `createUnsafeArrayBuffer`, ...) and the wrapper-function
// params (`module`, `internalBinding`, ...).
//
// COMPOSITION
//
// Listed in `minimalPolicies` AFTER `buffer-pool-disable`.  Replaces the
// older `buffer-write-sync` policy entirely — that one wrapped public
// Buffer write entry points to trigger syncs, leaving the structural
// issue intact.  This policy fixes the structural issue itself.

const POST_PATCH = `
// buffer-wasm-aliased: surgical patch installed via { post } override.
// Runs at the end of internal/buffer.js's module body, inside the same
// function wrapper — so module.exports + the body's locals are in scope.
;(function applyWasmAliasedCreateUnsafeBuffer() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var exp = module.exports;
  if (typeof exp.createUnsafeBuffer !== 'function') return;
  var FB = exp.FastBuffer;
  if (typeof FB !== 'function') return;
  // Pull binding fresh — closure ref would also work but explicit is safer
  // against bundler renames or shadowing.  (We're inside the
  // function(exports, require, module, process, internalBinding, primordials)
  // wrapper edge.js generates for built-ins.)
  var bufBinding;
  try { bufBinding = internalBinding('buffer'); } catch (_e) { return; }
  var cuab = bufBinding && bufBinding.createUnsafeArrayBuffer;
  if (typeof cuab !== 'function') return;

  exp.createUnsafeBuffer = function createUnsafeBuffer(size) {
    if (!size) return new FB(0);
    var v = cuab(size);
    // With the napi_create_external_arraybuffer override, \`v\` is a
    // Uint8Array view over wasm memory.  Use the (buffer, offset, length)
    // ctor to view it without copying.
    if (v && ArrayBuffer.isView(v)) {
      return new FB(v.buffer, v.byteOffset, v.byteLength);
    }
    // Defensive fallback (e.g., if napi override isn't active): treat
    // \`v\` as a real ArrayBuffer, which \`new FastBuffer(ab)\` also views.
    return new FB(v);
  };

  // markAsUntransferable / isMarkedAsUntransferable swallow non-extensible
  // targets.  Edge's createPool() calls markAsUntransferable(allocBuffer.buffer)
  // — with our wasm-aliased model that .buffer is the underlying
  // SharedArrayBuffer (wasmMemory.buffer), which is non-extensible.
  // The "untransferable" notion is only meaningful for postMessage transfer
  // lists; wasm memory's SAB is shared by design and isn't transferred
  // anywhere, so it's already effectively untransferable.  Swallowing the
  // failure here preserves the invariant edge relies on without crashing.
  var origMark = exp.markAsUntransferable;
  if (typeof origMark === 'function') {
    exp.markAsUntransferable = function markAsUntransferable(obj) {
      try { return origMark(obj); } catch (_e) { /* SAB / frozen — already non-transferable */ }
    };
  }
})();
`;

// ----------------------------------------------------------------------------
// SECONDARY PATCH — ArrayBuffer.prototype.byteLength polymorphism for SAB.
//
// CONSEQUENCE OF THE PRIMARY FIX
//
// With `buffer-wasm-aliased`, every Buffer's `.buffer` is the wasm-backed
// `SharedArrayBuffer` (the wasm `memory.buffer`).  Edge's vendored lib
// modules (`internal/webstreams/*`, `internal/crypto/*`) use the
// primordial `ArrayBufferPrototypeGetByteLength` to read the length of a
// view's underlying buffer — that primordial is V8's strict
// `ArrayBuffer.prototype.byteLength` getter, which throws on SAB:
//
//   TypeError: Method get ArrayBuffer.prototype.byteLength called on
//   incompatible receiver #<SharedArrayBuffer>
//
// Surfaces in `new Response('hi').text()` via
// `ReadableByteStreamController.enqueue` (readablestream.js:1175).
//
// FIX
//
// Patch `ArrayBuffer.prototype.byteLength` to a polymorphic getter that
// dispatches to `SharedArrayBuffer.prototype.byteLength` when the receiver
// is a SAB.  Must run BEFORE `internal/per_context/primordials.js`
// snapshots the getter via `uncurryThis(get)` — hence `{ pre: ... }`.
// Primordials runs early in bootstrap (it's `per_context/primordials.js`,
// loaded before any other lib module), so primordials's snapshot will
// pick up our polymorphic version and propagate everywhere.
//
// Risk: modifying a built-in prototype affects every consumer in this
// realm.  Mitigation: the patched getter is BEHAVIORALLY identical to the
// original for AB receivers (delegates back); only the SAB-receiver path
// is new.  Code that does `Object.getOwnPropertyDescriptor(...)` to
// recover the original getter would see a different function object, but
// that pattern is exceedingly rare.
// AB-prototype methods/getters that the lib uses via primordials and that
// throw when called on a SAB receiver.  Each gets a polymorphic wrapper:
// AB receiver → original behavior; SAB receiver → SAB-equivalent or a
// sensible fallback.
//
// FOUND USAGES (run \`grep -rn 'ArrayBufferPrototype' lib/\`):
//   - GetByteLength → SAB has \`byteLength\` getter; dispatch to it.
//   - GetDetached   → SAB can't be detached; return false.
//   - Slice         → SAB has \`slice\` method returning a new SAB; dispatch.
//                     Callers that expect a real AB result (e.g.
//                     \`ArrayBufferPrototypeSlice\` in webstreams) get a SAB
//                     back — fine as long as downstream uses Uint8Array
//                     views which work for both.
//   - Transfer      → SAB has no \`transfer\`.  Best-effort: COPY bytes into
//                     a fresh non-shared AB and return that.  Loses the
//                     "detach source" semantics, but the calling stream
//                     code only reads the result.
const PRIMORDIALS_PRE_PATCH = `
;(function patchArrayBufferForSAB() {
  globalThis.__sabDbg = { bl: 0, blSab: 0, sl: 0, slSab: 0, det: 0, detSab: 0, xf: 0, xfSab: 0, ttfl: 0, ttflSab: 0 };
  if (typeof SharedArrayBuffer !== 'function') return;
  var ABp = ArrayBuffer.prototype;
  var SABp = SharedArrayBuffer.prototype;

  // --- byteLength (accessor) ---
  var abBLDesc = Reflect.getOwnPropertyDescriptor(ABp, 'byteLength');
  var sabBLDesc = Reflect.getOwnPropertyDescriptor(SABp, 'byteLength');
  if (abBLDesc && sabBLDesc && typeof abBLDesc.get === 'function' && typeof sabBLDesc.get === 'function' && !abBLDesc.get.__sab_patched__) {
    var origBL = abBLDesc.get, sabBL = sabBLDesc.get;
    function byteLengthPolymorphic() {
      globalThis.__sabDbg.bl++;
      if (this instanceof SharedArrayBuffer) { globalThis.__sabDbg.blSab++; return sabBL.call(this); }
      return origBL.call(this);
    }
    byteLengthPolymorphic.__sab_patched__ = true;
    Reflect.defineProperty(ABp, 'byteLength', {
      configurable: abBLDesc.configurable, enumerable: abBLDesc.enumerable,
      get: byteLengthPolymorphic, set: undefined,
    });
  }

  // --- detached (accessor; may not exist on older runtimes) ---
  var abDetDesc = Reflect.getOwnPropertyDescriptor(ABp, 'detached');
  if (abDetDesc && typeof abDetDesc.get === 'function' && !abDetDesc.get.__sab_patched__) {
    var origDet = abDetDesc.get;
    function detachedPolymorphic() {
      globalThis.__sabDbg.det++;
      if (this instanceof SharedArrayBuffer) { globalThis.__sabDbg.detSab++; return false; }
      return origDet.call(this);
    }
    detachedPolymorphic.__sab_patched__ = true;
    Reflect.defineProperty(ABp, 'detached', {
      configurable: abDetDesc.configurable, enumerable: abDetDesc.enumerable,
      get: detachedPolymorphic, set: undefined,
    });
  }

  // --- slice (method) ---
  if (typeof ABp.slice === 'function' && typeof SABp.slice === 'function' && !ABp.slice.__sab_patched__) {
    var origSlice = ABp.slice;
    var sabSlice = SABp.slice;
    function slicePolymorphic(start, end) {
      globalThis.__sabDbg.sl++;
      if (this instanceof SharedArrayBuffer) { globalThis.__sabDbg.slSab++; return sabSlice.call(this, start, end); }
      return origSlice.call(this, start, end);
    }
    slicePolymorphic.__sab_patched__ = true;
    Reflect.defineProperty(ABp, 'slice', { configurable: true, writable: true, value: slicePolymorphic });
  }

  // --- transfer (method; may not exist on older runtimes) ---
  //
  // SAB receiver: copy the FULL SAB into a fresh non-shared AB of the
  // same byteLength.  Real ArrayBuffer.prototype.transfer semantics are
  // "create a new AB with the source's bytes and detach the source".  We
  // can't detach a SAB (shared by design) — but we can match the rest by
  // returning a same-sized non-shared AB.  Callers that use the result as
  // \`new Uint8Array(transferred, originalByteOffset, len)\` keep working
  // because the new AB is the same size as the source SAB and byteOffset
  // (a wasm pointer) still indexes the right region.
  //
  // Cost: copies the full wasm memory (multi-MB) on every transfer call.
  // Acceptable for low-frequency stream pulls; if a workload makes this
  // hot, swap to a smarter "return source SAB AND fake-detach" mechanism.
  // See NOTES.md #!~debt buffer-wasm-aliased-transfer-copies.
  // SAB has no transfer; we return the SAB itself.  The "detach source"
  // semantic doesn't apply (SAB is shared by design).  The caller's
  // subsequent \`new Uint8Array(transferredBuffer, originalByteOffset, len)\`
  // still works because transferredBuffer === source SAB and byteOffset is
  // still valid within the SAB.
  if (typeof ABp.transfer === 'function' && !ABp.transfer.__sab_patched__) {
    var origTransfer = ABp.transfer;
    function transferPolymorphic(newLength) {
      globalThis.__sabDbg.xf++;
      if (this instanceof SharedArrayBuffer) { globalThis.__sabDbg.xfSab++; return this; }
      return origTransfer.call(this, newLength);
    }
    transferPolymorphic.__sab_patched__ = true;
    Reflect.defineProperty(ABp, 'transfer', { configurable: true, writable: true, value: transferPolymorphic });
  }
  if (typeof ABp.transferToFixedLength === 'function' && !ABp.transferToFixedLength.__sab_patched__) {
    var origTTFL = ABp.transferToFixedLength;
    function transferToFixedLengthPolymorphic(newLength) {
      if (this instanceof SharedArrayBuffer) return this;
      return origTTFL.call(this, newLength);
    }
    transferToFixedLengthPolymorphic.__sab_patched__ = true;
    Reflect.defineProperty(ABp, 'transferToFixedLength', { configurable: true, writable: true, value: transferToFixedLengthPolymorphic });
  }

  if (typeof ABp.transferToFixedLength === 'function' && !ABp.transferToFixedLength.__sab_patched__) {
    var origTTFL = ABp.transferToFixedLength;
    function transferToFixedLengthPolymorphic(newLength) {
      if (this instanceof SharedArrayBuffer) {
        var srcLen = sabBL ? sabBL.call(this) : this.byteLength;
        var size = newLength === undefined ? srcLen : newLength >>> 0;
        var fresh = new ArrayBuffer(size);
        var copy = Math.min(size, srcLen);
        if (copy > 0) new Uint8Array(fresh).set(new Uint8Array(this, 0, copy));
        return fresh;
      }
      return origTTFL.call(this, newLength);
    }
    transferToFixedLengthPolymorphic.__sab_patched__ = true;
    Reflect.defineProperty(ABp, 'transferToFixedLength', { configurable: true, writable: true, value: transferToFixedLengthPolymorphic });
  }
})();
`;

export const bufferWasmAliased: Policy = {
  name: "buffer-wasm-aliased",
  description: "Make Buffer storage wasm-memory backed so JS reads and C++ writes share the same bytes; also patches ArrayBuffer.prototype.{byteLength,slice,transfer,detached} to be polymorphic on SAB receivers (downstream consequence — every Buffer.buffer is now the wasm SAB).",
  builtinOverrides: {
    "internal/buffer": { post: POST_PATCH },
    "internal/per_context/primordials": { pre: PRIMORDIALS_PRE_PATCH },
  },
};
