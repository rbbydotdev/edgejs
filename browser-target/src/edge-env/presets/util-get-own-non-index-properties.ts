// util-get-own-non-index-properties preset.
//
// Replaces internalBinding('util').getOwnNonIndexProperties with a JS
// impl that honors V8's PropertyFilter semantics.  The wasm-side
// implementation in edge.js ignores the filter bits and always returns
// all non-index properties — which makes `getOwnNonIndexProperties([],
// ONLY_ENUMERABLE)` wrongly return `["length"]` instead of `[]`.  That
// silently breaks `assert.deepStrictEqual([], [])` and every Array
// comparison through util/comparisons.js.
//
// Pre-patched on `internal/util/comparisons` so our replacement is in
// place before the module's top-of-file destructure on line 125.
//
// See `util-get-own-non-index-properties.patch.js` for the full
// rationale + V8 PropertyFilter semantics.

import type { Preset } from "../types";
import getOwnNonIndexPatchSrc from "./util-get-own-non-index-properties/util-get-own-non-index-properties.patch.js?raw";

export const utilGetOwnNonIndexProperties: Preset = {
  name: "util-get-own-non-index-properties",
  description:
    "JS replacement for internalBinding('util').getOwnNonIndexProperties " +
    "that honors V8's PropertyFilter bits (ONLY_ENUMERABLE etc.). " +
    "Fixes assert.deepStrictEqual on Arrays and any other type whose " +
    "non-index properties include non-enumerable slots.",
  patch: {
    "internal/util/comparisons": { pre: getOwnNonIndexPatchSrc },
  },
};
