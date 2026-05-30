// buffer-base64 preset.
//
// Fixes two interrelated bugs that surface in test-buffer-alloc.js (and
// any code path that does `Buffer.from(stringWithIllegalChars, 'base64')`):
//
//   1. Edge's wasm `internalBinding('buffer').base64Write` returns an empty
//      decode when the input contains illegal characters (0x80, 0xff, etc.)
//      instead of silently skipping them per RFC 4648 / Node behavior.
//   2. Even with a correct decoder, lib/buffer.js's `createFromString`
//      constructs the final view via `new FastBuffer(buf.buffer, 0, actual)`
//      when `actual < length`.  That assumes `buf.byteOffset === 0` which
//      is FALSE under our wasm-aliased Buffer model — every Buffer shares
//      the wasm SAB and `byteOffset` points into wasm memory.  Resulting
//      view reads as zeros.
//
// The fix patches `Buffer.from` for `(string, "base64"|"base64url")` to
// route through the vendored decoder + an exact-size allocation, which
// bypasses `createFromString` entirely.  All other `Buffer.from` calls
// delegate to the original.  See `buffer-from-base64.patch.js` for the
// full rationale.
//
// DEPENDENCIES
//
// - The vendored decoder is exposed on `globalThis.__edgeDecodeBase64`
//   by worker.ts (which imports it from
//   `src/edge-env/vendor-adapters/unenv-base64.ts`).  If the global
//   isn't installed (e.g. running under a different host), the patch
//   no-ops and the original (buggy) Buffer.from is used.
// - Requires `buffer-wasm-aliased` for `allocUnsafeSlow` to produce
//   the wasm-aliased view that `.set()` then writes into correctly.
//   Without `buffer-wasm-aliased`, the patch still runs but it's
//   redundant — stock allocUnsafeSlow has `byteOffset === 0` so the
//   underlying bug doesn't trigger.

import type { Preset } from "../types";
import bufferFromBase64Src from "./buffer-base64/buffer-from-base64.patch.js?raw";

export const bufferBase64: Preset = {
  name: "buffer-base64",
  description:
    "Fix Buffer.from(string, 'base64'|'base64url') to use the vendored " +
    "unenv/base64-js decoder (silently skips illegal characters per " +
    "RFC 4648) AND to allocate exact-size, bypassing lib/buffer.js's " +
    "createFromString — which constructs views at the wrong byteOffset " +
    "under the wasm-aliased Buffer model.",
  patch: {
    buffer: { post: bufferFromBase64Src },
  },
};
