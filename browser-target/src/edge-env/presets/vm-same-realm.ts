// vm-same-realm preset.
//
// Replaces vm.runInNewContext / vm.runInContext / vm.runInThisContext
// with same-realm `(0, eval)(code)` because browser workers have no
// synchronous primitive for a fresh JS realm (ShadowRealm restricts to
// primitives; iframes don't exist in workers; SAB+Atomics roundtrip
// would be async).
//
// HONEST about the limitation: documented in the patch source.  Tests
// that need cross-realm identity (e.g. instanceof across realms) WILL
// behave differently than Node — same-realm is MORE permissive — but
// tests that just use vm to construct an object and pass it to a host-
// side check (the common Buffer.byteLength pattern, cross-realm AB
// detection) work for the right reason: the object IS a real one from
// our realm.
//
// See `vm-same-realm.patch.js` for the full constraint list.

import type { Preset } from "../types";
import vmSameRealmSrc from "./vm-same-realm/vm-same-realm.patch.js?raw";

export const vmSameRealm: Preset = {
  name: "vm-same-realm",
  description:
    "Replace vm.runInNewContext / runInContext / runInThisContext with " +
    "same-realm `(0, eval)(code)`.  Browsers have no sync fresh-realm " +
    "primitive in workers, so we provide a more-permissive same-realm " +
    "eval that works for the common case of constructing values to pass " +
    "back to host code.  Tests that need true cross-realm identity will " +
    "still fail — those need ShadowRealm or iframe RPC.",
  patch: {
    vm: { post: vmSameRealmSrc },
  },
};
