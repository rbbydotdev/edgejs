import type { Preset } from "../types";

// **STATUS: Superseded by `buffer-wasm-aliased`** as of 2026-05-21.  Kept
// in the registry as an alternative / fallback diagnostic option (e.g.
// useful for isolating whether a future Buffer regression is in the
// wasm-aliased napi override or somewhere else).  New deployments should
// use `buffer-wasm-aliased`, which fixes the same bug at the structural
// layer (JS-side AB literally IS wasm memory; no JS↔wasm split exists).
//
// ----
//
// Wraps the public Buffer write entry points so that, after any C++ binding
// writes to a Buffer's wasm-side bytes, JS-side indexed access sees the
// updated bytes.
//
// THE BUG THIS FIXES
//
// In emnapi, edge.js's `internalBinding('buffer').createUnsafeArrayBuffer`
// produces a JS-heap `ArrayBuffer` of size N with a mapping in
// `emnapiExternalMemory.table` to a malloc'd wasm pointer.  Edge's C++ write
// bindings (`utf8WriteStatic`, `asciiWriteStatic`, `fill`, `copy`, ...) read
// the wasm pointer via `napi_get_buffer_info` and `memcpy` into wasm memory.
// JS-heap AB never updates, so `buf[i]` returns stale bytes until something
// (e.g. `buf.toString()`) triggers a napi call that re-syncs wasm → JS.
//
// The napi-host layer already syncs wasm → JS at the start of every
// `napi_get_buffer_info` / `napi_get_typedarray_info` call.  But that fires
// BEFORE the C++ memcpy in a write binding — too early.  Subsequent napi
// reads (`toString`, `hexSlice`, `compare`, ...) re-sync correctly.  The
// gap is direct indexed access immediately after a write with no napi-going
// op in between.
//
// WHY THIS LIVES AS A PRESET
//
// The bug is structural to emnapi's external_arraybuffer model + how lib's
// `new FastBuffer(value)` copies vs views.  Fixing it at the napi layer
// requires either re-architecting emnapi or wrapping every C++ binding
// dispatcher — both are out of scope for now.  This preset is the pragmatic
// JS-level fix that covers the realistic call paths.
//
// RESIDUAL GAP — see NOTES.md `#!~debt buffer-write-sync-residual`
//
// Wraps the public Buffer JS API — `Buffer.prototype.write`, `fill`, `copy`,
// and the factory paths `Buffer.from(string|array)`, `Buffer.alloc(size, fill)`.
// Any path where a C++ binding writes to a Buffer WITHOUT going through one
// of these (native addons calling `napi_get_buffer_info` + memcpy directly,
// edge's own stream-read paths that hand back a pre-allocated Buffer with
// wasm-side bytes set) won't be auto-synced.  In our current scope no
// native addons load, and most edge.js internal pipelines surface through
// a napi-going method eventually, so the gap is narrow.
//
// #!~debt buffer-write-sync-residual
//
// INCLUDED IN `minimalPolicies` because the bug is correctness, not optional.

const PRELUDE = `try {
  // The sync trigger: any napi-going call on the buffer fires our
  // napi_get_buffer_info patch, which copies wasm → JS for that buffer.
  // We pick \`compare(buf, buf)\` because it's pure (no writes), succeeds
  // on any same-length self-compare, and minimal work in C++ (memcmp of
  // identical pointers returns 0 immediately).
  //
  // Internal binding access via process.binding (public) — same underlying
  // object as internalBinding('buffer'), so the function reference is the
  // real C++ binding.
  const __bufBinding = process.binding('buffer');
  const __cmp = __bufBinding && __bufBinding.compareOffset;
  if (typeof __cmp !== 'function') {
    // Defensive: if the binding shape ever changes, fall back to a no-op
    // and accept the bug rather than crashing.  Other policies depend on
    // boot completing.
    throw new Error('compareOffset binding missing');
  }
  function __sync(buf) {
    if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
      try { __cmp(buf, buf, 0, 0, 0, 0); } catch (_e) { void _e; }
    }
  }

  // Buffer.prototype.write — utf8/ascii/latin1/base64/hex string → buf
  const __origWrite = Buffer.prototype.write;
  Buffer.prototype.write = function write(string, offset, length, encoding) {
    const r = __origWrite.call(this, string, offset, length, encoding);
    __sync(this);
    return r;
  };

  // Buffer.prototype.fill — fill with byte/string
  const __origFill = Buffer.prototype.fill;
  Buffer.prototype.fill = function fill(value, offset, end, encoding) {
    const r = __origFill.call(this, value, offset, end, encoding);
    __sync(this);
    return this; // fill returns this; r is this anyway
  };

  // Buffer.prototype.copy — writes into target
  const __origCopy = Buffer.prototype.copy;
  Buffer.prototype.copy = function copy(target, targetStart, sourceStart, sourceEnd) {
    const r = __origCopy.call(this, target, targetStart, sourceStart, sourceEnd);
    __sync(target);
    return r;
  };

  // Buffer.from — covers Buffer.from(string), Buffer.from(array), Buffer.from(arrayBuffer).
  // Returns a new Buffer that may have just been written by C++.
  const __origFrom = Buffer.from;
  Buffer.from = function from(value, encodingOrOffset, length) {
    const r = __origFrom.call(Buffer, value, encodingOrOffset, length);
    if (Buffer.isBuffer(r)) __sync(r);
    return r;
  };

  // Buffer.alloc — when fill is provided, C++ fills the wasm side
  const __origAlloc = Buffer.alloc;
  Buffer.alloc = function alloc(size, fill, encoding) {
    const r = __origAlloc.call(Buffer, size, fill, encoding);
    if (fill !== undefined && fill !== 0 && Buffer.isBuffer(r)) __sync(r);
    return r;
  };

  // Buffer.concat — internally uses copy(...) which we already wrap, BUT the
  // wrapping fires on each chunk's copy.  The final concatenated buffer is
  // safe because the last copy call syncs it.  No extra wrap needed.

} catch (e) {
  try { process.stderr.write('[buffer-write-sync] prelude failed: ' + (e && e.message) + '\\n'); } catch {}
};`;

export const bufferWriteSync: Preset = {
  name: "buffer-write-sync",
  description: "Sync wasm → JS after Buffer writes so indexed access (buf[i]) sees the bytes C++ wrote.",
  inject: PRELUDE,
};
