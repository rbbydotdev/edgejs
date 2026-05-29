// ESM-via-blob-import: wire per-module `importModuleDynamically`
// dispatch through to the browser-V8 blob trampoline in
// `napi-host/esm-registry.ts`.
//
// Backstory: phases 1–4 of the ESM bridge needed *two* policy patches.
// The `host_defined_option_symbol` synthesis was the first — without
// it, lib's `registerModule` threw `Invalid value used as weak map key`
// because edge's C++ `ModuleWrapCtor` didn't set the private symbol on
// the wrap. That's now fixed at the C++ layer
// (`src/internal_binding/binding_module_wrap.cc:ModuleWrapCtor` calls
// `unofficial_napi_create_private_symbol`).  The remaining JS-side
// work is the **per-URL dynamic-import registry**: our blob runs in
// browser-V8 and has no access to lib's `moduleRegistries` WeakMap
// (keyed by the private symbol), so we mirror the registry by URL and
// install a dispatcher around lib's global dynamic-import callback.
//
// What this policy does now:
//
// 1. Patches `internal/modules/esm/utils:registerModule` to mirror
//    each module's per-module dynamic-import registry into a Map
//    keyed by `referrer.url`.  Defensive Symbol synthesis is kept as
//    a belt-and-suspenders fallback in case the wasm is ever rolled
//    back to a build without the C++ fix.
//
// 2. Wraps `initializeESM` so that AFTER lib installs its global
//    `importModuleDynamicallyCallback`, we override it with a
//    dispatcher that prefers our per-URL registry.  This lets
//    `new vm.SourceTextModule(src, { importModuleDynamically: cb })`
//    actually fire `cb` even though the user code runs inside a
//    blob: URL evaluated by browser-V8.
//
// Default-on because without it, per-module dynamic import inside
// `vm.SourceTextModule` raises `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`
// when the user's source does `await import(specifier)`.

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

  // Per-module dynamic-import registry, keyed by the wrap's URL.  Our
  // blob trampoline runs in browser-V8 which has no access to lib's
  // moduleRegistries WeakMap (keyed by host_defined_option_symbol).
  // We mirror the registry here by URL so the dispatcher installed
  // below can route to the right per-module callback.
  var perUrlCallbacks = new Map();

  module.exports.registerModule = function registerModule(referrer, registry) {
    // edge's binding_module_wrap.cc:ModuleWrapCtor doesn't set the
    // host-defined-options Symbol on the wrap (Node does this through
    // v8::Script host-defined-options on the C++ side).  Synthesize
    // one so the downstream WeakMap.set(idSymbol, registry) doesn't
    // throw 'Invalid value used as weak map key'.  The Symbol value
    // is opaque — it's only used as a WeakMap key for dynamic-import
    // callback dispatch.  Skip if the referrer already has one OR is
    // one of lib's well-known fallback symbols.
    // #!~debt esm-via-blob-import-symbol-fallback: edge's C++
    // ModuleWrapCtor now sets host_defined_option_symbol natively
    // via unofficial_napi_create_private_symbol, so this Symbol
    // synthesis is redundant on current wasm builds.  Retained as
    // defensive backstop for wasm builds predating that C++ fix,
    // and for ModuleWraps created via paths that don't go through
    // ModuleWrapCtor.  Delete once the C++ fix is universal.
    if (referrer && referrer[hostDefinedOptionSymbol] === undefined) {
      try {
        referrer[hostDefinedOptionSymbol] = Symbol('edge-esm-hdo');
      } catch (_e) { void _e; /* referrer may be frozen; orig will throw a clear error */ }
    }
    // Mirror per-module importModuleDynamically by URL for the browser-
    // V8 blob trampoline.  callbackReferrer is the user's vm.Module
    // instance, not the wrap, so the per-module callback gets a
    // useful "this" referrer matching real Node semantics.
    if (registry && typeof registry.importModuleDynamically === 'function' && referrer && typeof referrer.url === 'string') {
      perUrlCallbacks.set(referrer.url, registry);
    }
    return orig.call(this, referrer, registry);
  };
  module.exports.__edgeEsmRegisterPatched = true;

  // Wrap initializeESM so that AFTER lib installs its global dynamic-
  // import callback (importModuleDynamicallyCallback from this same
  // module), we OVERRIDE it with a dispatcher that prefers our per-URL
  // registry.  This lets vm.SourceTextModule(src, { importModuleDynamically })
  // actually fire importModuleDynamically even though the blob runs
  // in browser-V8 — our __edgeDynImportImpl in the host calls back
  // into lib via the global callback (esmHostState.dynamicImportCallback)
  // and lands HERE.
  //
  // The local setImportModuleDynamicallyCallback and
  // importModuleDynamicallyCallback references are accessible from
  // the post-patch because the post body is injected inside the same
  // module wrapper as utils.js itself.
  if (typeof module.exports.initializeESM === 'function' && typeof setImportModuleDynamicallyCallback === 'function') {
    var origInitializeESM = module.exports.initializeESM;
    var origCallback = importModuleDynamicallyCallback;
    var edgeDispatcher = async function edgeDispatcher(referrerSymbol, specifier, phase, attributes, referrerName) {
      // Per-URL match: route to the user's vm.SourceTextModule
      // importModuleDynamically option, already wrapped by
      // importModuleDynamicallyWrap so it returns the namespace
      // (vm.Module → its .namespace, or a Module Namespace Object).
      if (typeof referrerName === 'string' && perUrlCallbacks.has(referrerName)) {
        var reg = perUrlCallbacks.get(referrerName);
        if (typeof reg.importModuleDynamically === 'function') {
          return reg.importModuleDynamically(specifier, reg.callbackReferrer || referrerName, attributes, phase);
        }
      }
      // Fall through to lib's symbol-based dispatch (default loader,
      // contextify scripts, etc.).
      return origCallback(referrerSymbol, specifier, phase, attributes, referrerName);
    };
    module.exports.initializeESM = function patchedInitializeESM(shouldSpawnLoaderHookWorker) {
      origInitializeESM(shouldSpawnLoaderHookWorker);
      // Override with our dispatcher.  setImportModuleDynamicallyCallback
      // replaces the global hook — both lib's own dynamic imports AND our
      // browser-V8 blob trampoline route through edgeDispatcher.
      try { setImportModuleDynamicallyCallback(edgeDispatcher); }
      catch (_e) { void _e; /* binding may not accept replacement; non-fatal */ }
    };
  }

  // Expose the module_wrap binding under a globalThis.__edge namespace so
  // tests + advanced users can construct ModuleWraps directly without
  // going through internalBinding.  Lib gates access to internalBinding;
  // process.binding('module_wrap') isn't on the allowlist.  This hook is
  // namespaced so it's clear it's not part of any Node-compat surface.
  try {
    var moduleWrapBinding = internalBinding('module_wrap');
    if (moduleWrapBinding && typeof moduleWrapBinding.ModuleWrap === 'function') {
      // #!~debt esm-test-modulewrap-escape-hatch: __edgeModuleWrap
      // exposes the module_wrap binding to user code for tests that
      // need to construct ModuleWrap instances directly (e.g. the
      // esm-require-preeval-* tests).  Non-Node-portable hook;
      // production user code should not rely on it.  Retire once
      // tests have a cleaner construction path via vm or a
      // test-only fixture API.
      Object.defineProperty(globalThis, '__edgeModuleWrap', {
        value: moduleWrapBinding,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
  } catch (_e) { void _e; /* binding may not be ready; non-fatal */ }
})();
`;

export const esmViaBlobImport: Policy = {
  name: "esm-via-blob-import",
  description: "Enable real ES Module execution via browser-native import(blob:URL) trampoline (napi-host/esm-registry.ts). Patches lib's moduleRegistry to tolerate missing host-defined-options symbol until C++ binding sets it.",
  builtinOverrides: {
    "internal/modules/esm/utils": { post: POST_PATCH },
  },
};
