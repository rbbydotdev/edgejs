// esm-require-sucrase-backstop: when require(esm) hits the
// pre-eval cache miss path and lib's `ModuleJobSync.runSync` would
// throw `ERR_REQUIRE_ASYNC_MODULE`, transform the ESM source to
// CJS via Sucrase's `imports` transform and eval as CJS.  Bumps
// require(esm) coverage from ~70% (b₁ alone) to ~95% at the cost
// of fake-ESM semantics — the returned namespace is a plain
// object populated by `exports.X = ...` writes, not a real Module
// Namespace Object.  Live bindings are approximated via Sucrase's
// getter pattern.  `Object.is(ns, await import(x))` is false.
//
// TLA modules CANNOT be sync-transformed (Sucrase can't sync-ify
// top-level await); they re-throw the original
// `ERR_REQUIRE_ASYNC_MODULE` unchanged.
//
// Opt-in only — NOT in `defaultBrowserPolicies`.  Enable via
// `composePolicies([..., esmRequireSucraseBackstop])` or
// `--policies esm-require-sucrase-backstop`.

import type { Policy } from "./index";

// Post-patch on internal/modules/esm/module_job.js — wraps
// `ModuleJobSync.prototype.runSync` so that on
// `ERR_REQUIRE_ASYNC_MODULE` we transform the source via Sucrase
// (exposed on globalThis by `worker.ts`) and eval the resulting
// CJS in a constructed CJS context.  Returns the same shape the
// original runSync does on success: `{ module, namespace }`.
const POST_PATCH = `
;(function installSucraseBackstop() {
  if (typeof module.exports.ModuleJobSync !== 'function') return;
  if (module.exports.ModuleJobSync.prototype.__edgeSucraseBackstopPatched) return;

  var ModuleJobSync = module.exports.ModuleJobSync;
  var origRunSync = ModuleJobSync.prototype.runSync;

  // Same heuristic as napi-host/esm-registry.ts:detectTopLevelAwait.
  // False positives are fine (we surface the original error); false
  // negatives mean we attempt the transform and fail at eval time.
  function hasTopLevelAwait(src) {
    return /(?:^|[\\s;{}(])await\\s/.test(src);
  }

  ModuleJobSync.prototype.runSync = function patchedRunSync(parent) {
    try {
      return origRunSync.call(this, parent);
    } catch (e) {
      if (!e || e.code !== 'ERR_REQUIRE_ASYNC_MODULE') throw e;
      if (typeof globalThis.__edgeEsmSucraseTransform !== 'function') throw e;
      var fileURLToPath;
      try { ({ fileURLToPath } = require('node:url')); } catch (_e) { void _e; throw e; }
      var fs;
      try { fs = require('fs'); } catch (_e2) { void _e2; throw e; }
      var createRequire;
      try { ({ createRequire } = require('node:module')); } catch (_e3) { void _e3; throw e; }
      var src;
      try { src = fs.readFileSync(fileURLToPath(this.url), 'utf8'); }
      catch (_e4) { void _e4; throw e; }
      if (hasTopLevelAwait(src)) throw e;
      var cjs = globalThis.__edgeEsmSucraseTransform(src);
      var mod = { exports: {} };
      var req = createRequire(this.url);
      var fn = new Function('require', 'module', 'exports', cjs);
      fn(req, mod, mod.exports);
      return { __proto__: null, module: this.module, namespace: mod.exports };
    }
  };
  ModuleJobSync.prototype.__edgeSucraseBackstopPatched = true;
})();
`;

export const esmRequireSucraseBackstop: Policy = {
  name: "esm-require-sucrase-backstop",
  description:
    "Backstop for require(esm): when the pre-eval cache misses, transform the ESM source via Sucrase and eval as CJS. Bumps coverage from ~70% (b₁ alone) to ~95% at the cost of fake-ESM semantics. TLA modules still throw. Opt-in.",
  builtinOverrides: {
    "internal/modules/esm/module_job": { post: POST_PATCH },
  },
};
