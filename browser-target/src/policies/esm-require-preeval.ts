// esm-require-preeval: pre-populate an ESM namespace cache before
// user CJS code runs, so synchronous `require('./x.mjs')` calls can
// succeed without JSPI suspension (which is structurally impossible
// in browser-target — see `#!~debt esm-evaluate-sync-jspi-blocked`
// in NOTES.md).
//
// Architecture:
//
// Our `unofficial_napi_module_wrap_evaluate_sync` handler in
// `napi-host/unofficial.ts` consults a Map<file-URL, namespace> on
// `globalThis.__edgePreEvalEsmCache` before throwing
// `ERR_REQUIRE_ASYNC_MODULE`.  The cache is populated here by:
//
//   1. `globalThis.edgejs.preloadEsm([...])` — explicit user-facing API
//      that does `await import(spec)` for each specifier and stashes
//      the resulting namespace.  Used when the caller knows what
//      .mjs files their CJS code will require.
//
//   2. Auto pre-scan of the entry CJS source for literal
//      `require('./x.mjs')` patterns at boot, BEFORE `evalScript`
//      runs the user code.  Recursively walks transitive CJS deps
//      (`.cjs` and `.js` files reached via literal `require()`
//      patterns) collecting all .mjs targets to preload.  Misses
//      computed specifiers (`require(name)`, `require(`./${x}`)`),
//      runtime-discovered files (fs.readdir + require), and anything
//      behind a build-time bundler that emits non-literal shapes —
//      see NOTES.md for the full ~30% gap and remediation.
//
// Coverage / failure mode:
//
//   * ~70% of real `require(esm)` cases work transparently with the
//     auto-scan path.  The remaining ~30% fall through to the clear
//     `ERR_REQUIRE_ASYNC_MODULE` with the `preloadEsm` remediation
//     in the message.
//   * For the long tail, callers can call `edgejs.preloadEsm([...])`
//     at startup (typically in an async IIFE wrapping their CJS
//     entry).  Misses only fully-dynamic loads.

import type { Policy } from "./index";

// User-facing prelude — concatenated in front of every `-e` script.
// Defines `globalThis.edgejs.preloadEsm` and sets up the cache.
// Cheap, sync, always installed.
const USER_PRELUDE = `
;(function installEsmPreloadApi() {
  if (globalThis.__edgePreEvalEsmCache) return;
  var cache = new Map();
  Object.defineProperty(globalThis, '__edgePreEvalEsmCache', {
    value: cache, writable: false, enumerable: false, configurable: false,
  });
  if (!globalThis.edgejs) globalThis.edgejs = {};
  // edgejs.preloadEsm(specifiers, options?) — preload ESM modules so
  // they can be require()'d synchronously later.  Specifiers are
  // resolved relative to options.from (default: process.cwd()).
  globalThis.edgejs.preloadEsm = async function preloadEsm(specifiers, options) {
    if (!Array.isArray(specifiers)) throw new TypeError('preloadEsm: specifiers must be an array');
    var from = (options && options.from) || (process.cwd() + '/');
    if (!from.endsWith('/')) from += '/';
    var base = from.startsWith('file:') ? from : ('file://' + from);
    for (var i = 0; i < specifiers.length; i++) {
      var spec = specifiers[i];
      var url;
      if (spec.startsWith('file:') || spec.startsWith('http:') || spec.startsWith('https:') || spec.startsWith('blob:') || spec.startsWith('data:')) {
        url = spec;
      } else {
        url = new URL(spec, base).href;
      }
      if (cache.has(url)) continue;
      var ns = await import(url);
      cache.set(url, ns);
    }
  };
})();
`;

// Post-patch on internal/process/execution.js — wraps `evalScript`
// with a scan + preload step that runs FIRST.  We patch this module
// (not eval_string.js) because eval_string.js calls evalScript as
// the terminal action and goes out of scope; a post-patch there
// runs too late.  By the time eval_string.js does
// `const { evalScript } = require('internal/process/execution')`,
// the destructure picks up our wrapped version.
//
// Behavior change: wrapped evalScript returns a Promise (lib's
// caller ignores the return value, so this is safe).  User code
// execution is deferred until preload completes.  Process stays
// alive because of the in-flight preload Promise.
//
// Limitation: lib's path is `eval_string.js → evalScript`.  If lib
// adds a new code path that bypasses evalScript, the auto-scan
// degrades — callers still have `edgejs.preloadEsm` as the
// fallback escape hatch.
const EXECUTION_POST_PATCH = `
;(function installEsmRequirePreevalScan() {
  if (typeof module.exports.evalScript !== 'function') return;
  if (module.exports.__edgeEsmPreevalPatched) return;
  module.exports.__edgeEsmPreevalPatched = true;

  // Scanner: extract require() specifiers that look like literal
  // strings.  Catches:
  //   require('./x.mjs')
  //   require("./x.mjs")
  //   require(\`./x.mjs\`)            (only when there's no \${} interpolation)
  // Misses dynamic / computed specifiers — that's the documented gap.
  function extractRequireSpecifiers(src) {
    var out = [];
    var re = /\\brequire\\s*\\(\\s*(['"\`])([^'"\`]+?)\\1\\s*\\)/g;
    var m;
    while ((m = re.exec(src)) !== null) out.push(m[2]);
    return out;
  }

  function isEsmExtension(p) { return /\\.mjs(\\?|#|$)/.test(p); }
  function isCjsExtension(p) { return /\\.(cjs|js)(\\?|#|$)/.test(p); }

  // Walk the static require graph, collecting .mjs file paths to
  // preload.  Reads transitive CJS files via fs.readFileSync (which
  // is backed by the SAB ring in browser-target -- fast for files
  // edge.js's bundled-fs has).
  function collectEsmTargets(entrySrc, entryBase) {
    var fs, path;
    try { fs = require('fs'); } catch (_e) { void _e; return []; }
    try { path = require('path'); } catch (_e) { void _e; return []; }
    var visitedCjs = new Set();
    var esmTargets = [];

    function resolve(spec, fromPath) {
      // Best-effort relative resolution.  Doesn't handle node_modules
      // or package exports — covers the literal-relative case that's
      // the bulk of real require(esm) usage.
      if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/')) return null;
      try {
        var dir = path.dirname(fromPath);
        return path.resolve(dir, spec);
      } catch (_e) { void _e; return null; }
    }

    function walk(src, fromPath) {
      var specs = extractRequireSpecifiers(src);
      for (var i = 0; i < specs.length; i++) {
        var resolved = resolve(specs[i], fromPath);
        if (!resolved) continue;
        if (isEsmExtension(resolved)) {
          esmTargets.push(resolved);
        } else if (isCjsExtension(resolved)) {
          if (visitedCjs.has(resolved)) continue;
          visitedCjs.add(resolved);
          var depSrc;
          try { depSrc = fs.readFileSync(resolved, 'utf8'); } catch (_e) { void _e; continue; }
          walk(depSrc, resolved);
        }
        // No extension: could be CJS or ESM; skip — caller gets the
        // clear error at runtime if it's an ESM target.
      }
    }

    walk(entrySrc, entryBase);
    return esmTargets;
  }

  var origEvalScript = module.exports.evalScript;
  module.exports.evalScript = function patchedEvalScript(name, body, breakOnFirstLine, print, shouldLoadESM) {
    var entryBase;
    try { entryBase = process.cwd() + '/[eval]'; }
    catch (_e) { void _e; entryBase = '/[eval]'; }
    var targets;
    try { targets = collectEsmTargets(body, entryBase); }
    catch (_e) { void _e; targets = []; }
    if (targets.length === 0) {
      return origEvalScript(name, body, breakOnFirstLine, print, shouldLoadESM);
    }
    var urls = targets.map(function (p) { return 'file://' + p; });
    // Fire-and-forget the preload, then eval.  Lib's main entry
    // doesn't await evalScript's return; in-flight preload keeps the
    // event loop alive until user code runs.
    (async function () {
      try {
        if (typeof globalThis.edgejs?.preloadEsm === 'function') {
          await globalThis.edgejs.preloadEsm(urls);
        }
      } catch (_e) { void _e; /* preload failure -> fall through; require() surfaces its own error */ }
      origEvalScript(name, body, breakOnFirstLine, print, shouldLoadESM);
    })();
  };
})();
`;

export const esmRequirePreeval: Policy = {
  name: "esm-require-preeval",
  description: "Pre-populate ESM namespace cache so synchronous require('./x.mjs') from CJS works without JSPI suspension. Auto-scans entry CJS source + transitively walked CJS deps for literal require() specifiers; user can also call edgejs.preloadEsm([...]) explicitly. Misses computed/dynamic specifiers — those still throw ERR_REQUIRE_ASYNC_MODULE with a remediation message.",
  userScriptPrelude: USER_PRELUDE,
  builtinOverrides: {
    "internal/process/execution": { post: EXECUTION_POST_PATCH },
  },
};
