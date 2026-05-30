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
    // Pre-patch on EVERY module that destructures
    // `internalBinding('util').getOwnNonIndexProperties` at top-of-file —
    // load order isn't guaranteed, so we need our binding swap to land
    // BEFORE any consumer captures the broken function.  Identical patch
    // body is fine: each is idempotent via the `__edgeGetOwnNonIndexPatched`
    // sentinel.  Consumers (per `grep -rln getOwnNonIndexProperties lib/`):
    //   - internal/util.js (the early loader)
    //   - internal/util/inspect.js (util.inspect)
    //   - internal/util/comparisons.js (assert.deepStrictEqual + isDeepStrictEqual)
    //   - internal/repl/completion.js (REPL tab-complete)
    //   - lib/buffer.js (constants destructure)
    "internal/util": { pre: getOwnNonIndexPatchSrc },
    "internal/util/inspect": { pre: getOwnNonIndexPatchSrc },
    "internal/util/comparisons": { pre: getOwnNonIndexPatchSrc },
    "internal/repl/completion": { pre: getOwnNonIndexPatchSrc },
    buffer: { pre: getOwnNonIndexPatchSrc },
  },
};
