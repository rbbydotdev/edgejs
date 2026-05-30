// util-types-async-gen preset.
//
// Fixes internalBinding('types').isAsyncFunction / .isGeneratorFunction
// to ALSO return true for AsyncGeneratorFunction values, matching V8 /
// real Node behavior.  Edge.js's wasm impl only recognises the pure
// `async`/`generator` kinds and treats `async function* () {}` as
// neither, which breaks util.inspect's type-name composition at
// lib/internal/util/inspect.js:1313-1319.
//
// Pre-patched on `internal/util/types` so the override lands BEFORE
// the top-level `module.exports = { ...internalBinding('types'), ... }`
// spread captures the binding.  See the patch file for the full
// rationale.

import type { Preset } from "../types";
import utilTypesAsyncGenPatchSrc from "./util-types-async-gen/util-types-async-gen.patch.js?raw";

export const utilTypesAsyncGen: Preset = {
  name: "util-types-async-gen",
  description:
    "Patch internalBinding('types').isAsyncFunction / .isGeneratorFunction " +
    "to return true for AsyncGeneratorFunction values — matches V8 / real " +
    "Node behavior and lets util.inspect render '[AsyncGeneratorFunction: " +
    "abc]' instead of '[GeneratorFunction: abc] AsyncGeneratorFunction'.",
  patch: {
    "internal/util/types": { pre: utilTypesAsyncGenPatchSrc },
  },
};
