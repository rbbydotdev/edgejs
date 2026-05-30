// process-binding-inspector-stub preset.
//
// Provides an empty-object stub for `internalBinding('inspector')` so
// `process.binding('inspector')` returns a truthy value instead of
// undefined.  Fixes test-process-binding-internalbinding-allowlist.js
// without enabling any real inspector functionality (which the browser
// build can't support anyway).
//
// See `process-binding-inspector-stub.patch.js` for the full rationale.

import type { Preset } from "../types";
import inspectorStubSrc from "./process-binding-inspector-stub/process-binding-inspector-stub.patch.js?raw";

export const processBindingInspectorStub: Preset = {
  name: "process-binding-inspector-stub",
  description:
    "Wraps globalThis.getInternalBinding so internalBinding('inspector') " +
    "returns {} instead of undefined.  Satisfies process.binding('inspector') " +
    "truthy assertions without exposing real (unsupported) inspector methods.",
  patch: {
    // Pre-patch on realm bootstrap so the wrapper is installed BEFORE
    // realm's `internalBinding` closure captures `getInternalBinding`.
    "internal/bootstrap/realm": { pre: inspectorStubSrc },
  },
};
