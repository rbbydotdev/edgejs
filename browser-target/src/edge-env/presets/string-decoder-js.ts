// string-decoder-js preset.
//
// Replaces internalBinding('string_decoder').decode / .flush with pure-JS
// implementations.  Edge's native impl ultimately routes through
// `Buffer.from(bytes).toString(encoding)` (edge_string_decoder.cc:216 "First
// try" path) — which has two bugs that surface in test-string-decoder.js
// and test-string-decoder-end.js:
//
//   1. UTF-8 with ill-formed sequences (e.g. C9 B5 A9 41) returns garbage
//      surrogate-pair output instead of U+0275 U+FFFD A.
//   2. base64 input with trailing partial bytes is encoded incorrectly,
//      same root cause buffer-base64 preset works around for Buffer.from.
//
// Re-implementing in JS lets us keep WHATWG-spec UTF-8 invalid-byte
// handling AND share Buffer's exact base64 encoder output.  See
// `string-decoder-js.patch.js` for the full rationale.

import type { Preset } from "../types";
import stringDecoderJsSrc from "./string-decoder-js/string-decoder-js.patch.js?raw";

export const stringDecoderJs: Preset = {
  name: "string-decoder-js",
  description:
    "JS replacement for internalBinding('string_decoder').decode / .flush " +
    "that fixes UTF-8 ill-formed-sequence handling and base64 trailing-byte " +
    "encoding, matching Node's documented invalid-byte → U+FFFD substitution.",
  patch: {
    // Pre-patch on lib/string_decoder.js so the binding is replaced
    // BEFORE the module's top-of-file destructure captures decode/flush.
    string_decoder: { pre: stringDecoderJsSrc },
    // Same patch on lib/buffer.js — the same script also installs JS
    // replacements for internalBinding('buffer').utf8Slice / base64Slice
    // / hexSlice / etc.  Has to land BEFORE buffer.js's top-of-file
    // destructure captures the (broken) wasm-side slice functions.
    // Idempotent via the __edgeBufferSliceJsPatched sentinel.
    buffer: { pre: stringDecoderJsSrc },
  },
};
