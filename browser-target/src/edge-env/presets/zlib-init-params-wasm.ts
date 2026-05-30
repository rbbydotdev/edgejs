// zlib-init-params-wasm preset.
//
// Companion to zlib-writestate-wasm: makes the FIRST init-arg (the
// per-stream Uint32Array of brotli/zstd params) wasm-backed on every
// call, so changing params between successive Brotli/Zstd instances
// actually takes effect.  Without this, lib/zlib.js's module-level
// `brotliInitParamsArray` shares a stale wasm mirror across instances
// and `BROTLI_PARAM_QUALITY` becomes a no-op.
//
// See `zlib-init-params-wasm/zlib-init-params-wasm.patch.js` for the
// full rationale.

import type { Preset } from "../types";
import patchSrc from "./zlib-init-params-wasm/zlib-init-params-wasm.patch.js?raw";

export const zlibInitParamsWasm: Preset = {
  name: "zlib-init-params-wasm",
  description:
    "Make brotli/zstd init params Uint32Array wasm-backed per call " +
    "so changing params (e.g. BROTLI_PARAM_QUALITY) between successive " +
    "instances actually reaches the wasm side.  Depends on buffer-wasm-aliased.",
  patch: {
    zlib: { post: patchSrc },
  },
};
