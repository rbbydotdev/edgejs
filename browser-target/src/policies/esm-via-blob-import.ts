// ESM-via-blob-import: enable real ES Module execution in the browser-
// target by patching lib's loader machinery to tolerate the napi
// stubs in `napi-host/esm-registry.ts` driving evaluation through the
// browser's native `import(blob:URL)`.
//
// What this policy does:
//
// 1. Patches `internal/modules/esm/utils` to make `registerModule`
//    tolerant of a missing `host_defined_option_symbol` on the
//    referrer.  Edge's C++ `ModuleWrapCtor` in
//    `src/internal_binding/binding_module_wrap.cc:307` doesn't set
//    this symbol (Node's C++ wraps it via host-defined options on the
//    underlying v8::Script; we don't have that bridge yet, and adding
//    it requires a wasm rebuild).  Instead the JS-side patch
//    synthesizes a fresh per-wrap Symbol when none is present so
//    the WeakMap key requirement is satisfied.  Once the C++
//    bridge ships (future phase), this patch becomes a no-op and
//    the policy can be retired.
//
// 2. Keeps `--experimental-vm-modules` runtime semantics — this
//    policy doesn't toggle the flag; that happens in `worker.ts`
//    where the args are constructed.
//
// Naming: the policy's job is to make ESM work via the blob trampoline
// in `napi-host/esm-registry.ts`, hence the name.  Default-on because
// without it, `vm.SourceTextModule` and any `import` syntax with
// `--input-type=module` would crash on the WeakMap key error.

import type { Policy } from "./index";

const POST_PATCH = `
;(function installEsmViaBlobImportPostPatch() {
  // module.exports here is internal/modules/esm/utils — see the
  // file's actual destructuring at lib/internal/modules/esm/utils.js
  // top of file.  If registerModule isn't a function, lib's shape
  // changed; bail rather than corrupt it.
  if (typeof module.exports.registerModule !== 'function') return;
  if (module.exports.__edgeEsmRegisterPatched) return;

  // Pull the private symbol from internalBinding('util').  This is
  // the same source lib uses, so the symbol identity matches whatever
  // any other consumer of moduleRegistries would look up.
  var utilBinding = internalBinding('util');
  var hostDefinedOptionSymbol =
    utilBinding && utilBinding.privateSymbols &&
    utilBinding.privateSymbols.host_defined_option_symbol;
  if (typeof hostDefinedOptionSymbol !== 'symbol') return;

  var orig = module.exports.registerModule;
  module.exports.registerModule = function registerModule(referrer, registry) {
    // edge's binding_module_wrap.cc:ModuleWrapCtor doesn't set the
    // host-defined-options Symbol on the wrap (Node does this through
    // v8::Script host-defined-options on the C++ side).  Synthesize
    // one so the downstream WeakMap.set(idSymbol, registry) doesn't
    // throw 'Invalid value used as weak map key'.  The Symbol value
    // is opaque — it's only used as a WeakMap key for dynamic-import
    // callback dispatch.  Skip if the referrer already has one OR is
    // one of lib's well-known fallback symbols.
    if (referrer && referrer[hostDefinedOptionSymbol] === undefined) {
      try {
        referrer[hostDefinedOptionSymbol] = Symbol('edge-esm-hdo');
      } catch (_e) { void _e; /* referrer may be frozen; orig will throw a clear error */ }
    }
    return orig.call(this, referrer, registry);
  };
  module.exports.__edgeEsmRegisterPatched = true;
})();
`;

export const esmViaBlobImport: Policy = {
  name: "esm-via-blob-import",
  description: "Enable real ES Module execution via browser-native import(blob:URL) trampoline (napi-host/esm-registry.ts). Patches lib's moduleRegistry to tolerate missing host-defined-options symbol until C++ binding sets it.",
  builtinOverrides: {
    "internal/modules/esm/utils": { post: POST_PATCH },
  },
};
