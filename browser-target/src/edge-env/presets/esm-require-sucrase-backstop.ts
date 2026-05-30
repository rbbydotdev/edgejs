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

import type { Preset } from "../types";

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

  // TLA detection via compile attempt — no regex heuristic, no
  // parser dependency.  Sucrase's imports transform converts
  // import statements to require() calls but leaves any top-level
  // await token unchanged.  Feeding the result to
  // new Function(...) then triggers a SyntaxError at compile time
  // (Function bodies are synchronous and disallow await outside an
  // async context).  SyntaxError mentioning 'await' → had TLA →
  // re-throw original error.  Other compile errors propagate
  // through to the user.

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
      // Pass filePath so Sucrase emits a source map and appends a
      // sourceMappingURL data-URL comment; V8 honors that inside
      // new Function compilation, so runtime stack traces from the
      // eval'd code map back to the original .mjs lines.
      var filePath;
      try { filePath = fileURLToPath(this.url); } catch (_e5) { void _e5; filePath = undefined; }
      var cjs = globalThis.__edgeEsmSucraseTransform(src, filePath ? { filePath: filePath } : undefined);
      var fn;
      try { fn = new Function('require', 'module', 'exports', cjs); }
      catch (compileErr) {
        // SyntaxError most likely means top-level await (or some
        // other CJS-incompatible construct).  Distinguish by message
        // when possible; otherwise conservatively re-throw the
        // original ERR_REQUIRE_ASYNC_MODULE.
        var msg = (compileErr && compileErr.message) || '';
        if (/await/i.test(msg)) throw e;
        // Non-await syntax error indicates a bug in the source or
        // the transform — re-throw the compile error directly so
        // the user sees what's actually wrong.
        throw compileErr;
      }
      var mod = { exports: {} };
      var req = createRequire(this.url);
      fn(req, mod, mod.exports);
      return { __proto__: null, module: this.module, namespace: mod.exports };
    }
  };
  ModuleJobSync.prototype.__edgeSucraseBackstopPatched = true;
})();
`;

export const esmRequireSucraseBackstop: Preset = {
  name: "esm-require-sucrase-backstop",
  description:
    "Backstop for require(esm): when the pre-eval cache misses, transform the ESM source via Sucrase and eval as CJS. Bumps coverage from ~70% (b₁ alone) to ~95% at the cost of fake-ESM semantics. TLA modules still throw. Opt-in.",
  patch: {
    "internal/modules/esm/module_job": { post: POST_PATCH },
  },
};
