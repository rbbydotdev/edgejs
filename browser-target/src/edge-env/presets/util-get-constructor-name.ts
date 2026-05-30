// util-get-constructor-name preset.
//
// Replaces internalBinding('util').getConstructorName with a JS impl
// backed by a WeakMap that stashes an object's constructor name
// BEFORE Object.setPrototypeOf / Reflect.setPrototypeOf mutates the
// prototype chain.  Edge.js's wasm impl walks the live prototype
// chain and falls back to "Object" once the chain is broken, so
// `util.format('%s', Object.setPrototypeOf(new Foo(), null))`
// reports `[Object: null prototype] {}` instead of the V8-correct
// `[Foo: null prototype] {}`.
//
// Pre-patched on `internal/util/inspect` and `internal/util` so the
// setPrototypeOf wraps land before user code mutates any prototypes.
// See the patch file for full rationale and limitations.

import type { Preset } from "../types";
import utilGetConstructorNamePatchSrc from "./util-get-constructor-name/util-get-constructor-name.patch.js?raw";

export const utilGetConstructorName: Preset = {
  name: "util-get-constructor-name",
  description:
    "JS replacement for internalBinding('util').getConstructorName backed " +
    "by a WeakMap populated from a wrapped Object.setPrototypeOf / " +
    "Reflect.setPrototypeOf.  Fixes util.inspect / util.format on objects " +
    "whose prototype has been swapped to null (V8 retains the original " +
    "constructor name in its hidden Map; edge.js's wasm impl can't).",
  patch: {
    "internal/util": { pre: utilGetConstructorNamePatchSrc },
    "internal/util/inspect": { pre: utilGetConstructorNamePatchSrc },
  },
};
