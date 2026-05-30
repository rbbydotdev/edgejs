import type { Preset } from "../types";

// Forces `Buffer.poolSize = 0` inside the user `-e` script's realm so edge's
// pool-slicing path is bypassed.  Edge's `Buffer.allocate(size)` checks
// `Buffer.poolSize >>> 1` PER-CALL — setting it once in user code is enough.
//
// WHY THIS IS NOT OPTIONAL IN PRACTICE
//
// Edge's pool allocator slices a single shared `allocPool` (a wasm-backed
// view in our setup) into per-Buffer regions, computing addresses as
// `new FastBuffer(allocPool, poolOffset, size)`.  Because our `allocPool`
// has `.buffer === wasmMemory.buffer`, FastBuffer treats poolOffset as a
// wasm-memory-absolute offset rather than a pool-relative one.  Slices
// land at wrong addresses → crypto digests, randomBytes, etc. return
// wrong bytes.  Disabling the pool sidesteps the impedance.
//
// HISTORY: see ARCHIVE.md 2026-05-21 "Crypto FULL surface working" for the
// trace that pinned this down.  Tried hooking globalThis.Buffer.poolSize
// via napi_call_function from the host — confirmed user code's Buffer
// class is a different realm/context object than the host's, so host
// assignment doesn't reach it.

export const bufferPoolDisable: Preset = {
  name: "buffer-pool-disable",
  description: "Sets Buffer.poolSize=0 so edge's pool slicing doesn't corrupt crypto/Buffer ops.",
  inject: "try{Buffer.poolSize=0}catch{};",
};
