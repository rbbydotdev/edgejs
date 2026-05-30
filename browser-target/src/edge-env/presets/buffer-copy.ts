// buffer-copy preset.
//
// Replaces internalBinding('buffer').copy with a JS impl that uses V8's
// TypedArray.prototype.set() — fixes a byteOffset-handling bug in the
// wasm-side copy when the target has a non-zero byteOffset under our
// wasm-aliased Buffer model.
//
// Same root-cause family as the createFromString bug fixed by
// buffer-base64.  See `buffer-copy.patch.js` for the full rationale.

import type { Preset } from "../types";
import bufferCopyPatchSrc from "./buffer-copy/buffer-copy.patch.js?raw";

export const bufferCopy: Preset = {
  name: "buffer-copy",
  description:
    "Replace internalBinding('buffer').copy with a JS impl using " +
    "TypedArray.prototype.set() so byteOffset is honored on both " +
    "source and target — fixes test-buffer-copy when target is a " +
    "Uint8Array view with non-zero byteOffset.",
  patch: {
    buffer: { pre: bufferCopyPatchSrc },
  },
};
