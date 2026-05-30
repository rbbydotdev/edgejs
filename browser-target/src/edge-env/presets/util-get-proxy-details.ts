// util-get-proxy-details preset.
//
// Replaces internalBinding('util').getProxyDetails with a JS impl
// backed by a WeakMap registry populated by a wrapped global `Proxy`
// constructor.  Edge.js's wasm impl returns `undefined` for every
// Proxy, which leaks proxy traps through util.inspect / util.format
// (the inspect entry points rely on getProxyDetails to unwrap before
// reading the target's properties).
//
// Pre-patched on `internal/util/inspect`, `internal/util/comparisons`,
// and the early `internal/util` loader so the Proxy wrap is in place
// before any user code (or vendored lib that re-imports util) runs.
// See the patch file for full rationale, limitations, and the
// Proxy.revocable handling.

import type { Preset } from "../types";
import utilGetProxyDetailsPatchSrc from "./util-get-proxy-details/util-get-proxy-details.patch.js?raw";

export const utilGetProxyDetails: Preset = {
  name: "util-get-proxy-details",
  description:
    "JS replacement for internalBinding('util').getProxyDetails backed by " +
    "a wrapped global `Proxy` constructor + WeakMap registry.  Fixes " +
    "util.inspect / util.format on Proxy values whose traps would " +
    "otherwise leak through (e.g. test-util-inspect-proxy.js where every " +
    "trap throws).",
  patch: {
    "internal/util": { pre: utilGetProxyDetailsPatchSrc },
    "internal/util/inspect": { pre: utilGetProxyDetailsPatchSrc },
    "internal/util/comparisons": { pre: utilGetProxyDetailsPatchSrc },
  },
};
