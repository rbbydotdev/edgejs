// Minimal `common` shim for ported node/test/parallel/test-* tests.
//
// Mirrors the subset of node/test/common/index.js the worker-threads
// test corpus needs.  This file is NOT a test — the browser test
// runner picks it up via the `prelude=common-shim` harness-arg
// (see browser-test-runner.mjs collectTests filter).
//
// Exposes a single `common` global plus mirrors the legacy
// require('common') / require('../common') module shape so ported
// tests can use either form.  Module resolution inside edge.js's
// in-memory require can't see this dir, so the global IS the path —
// ported tests need their first line rewritten from
// `const common = require('../common');` to
// `const common = globalThis.common;` (we leave that one-line edit
// to the porter; the runner doesn't try to rewrite source).

(function installCommonShim() {
  if (globalThis.common) return;

  var checks = [];
  var exitedCleanly = false;

  function noop() {}

  function runChecks(code) {
    // Node's common only enforces when code === 0 (matches its
    // runCallChecks).  Tests that fail intentionally would otherwise
    // double-report.
    if (code !== 0) return;
    var failed = checks.filter(function(c) {
      if ('minimum' in c) return c.actual < c.minimum;
      return c.actual !== c.exact;
    });
    if (failed.length === 0) return;
    failed.forEach(function(c) {
      var want = ('minimum' in c) ? ('at least ' + c.minimum) : ('exactly ' + c.exact);
      console.log('Mismatched ' + c.name + ' function calls. Expected ' + want + ', actual ' + c.actual + '.');
    });
    try { process.exit(1); } catch (e) { void e; }
  }

  function ensureExitHook() {
    if (exitedCleanly) return;
    exitedCleanly = true;
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
      process.on('exit', runChecks);
    }
  }

  function mustCallInner(fn, criteria, field) {
    if (typeof fn === 'number') { criteria = fn; fn = noop; }
    if (fn === undefined) fn = noop;
    if (criteria === undefined) criteria = 1;
    if (typeof criteria !== 'number') {
      throw new TypeError('common.mustCall: ' + field + ' must be a number');
    }
    ensureExitHook();
    var ctx = { actual: 0, name: fn.name || '<anonymous>' };
    ctx[field] = criteria;
    checks.push(ctx);
    return function() {
      ctx.actual++;
      return fn.apply(this, arguments);
    };
  }

  function mustCall(fn, exact) {
    return mustCallInner(fn, exact, 'exact');
  }

  function mustCallAtLeast(fn, minimum) {
    return mustCallInner(fn, minimum, 'minimum');
  }

  function mustNotCall(msg) {
    return function mustNotCall_inner() {
      var args = Array.prototype.slice.call(arguments);
      var detail = args.length > 0 ? ' (called with ' + args.length + ' args)' : '';
      throw new Error((msg || 'function should not have been called') + detail);
    };
  }

  function mustSucceed(fn, exact) {
    return mustCall(function(err) {
      if (err) throw err;
      if (typeof fn === 'function') {
        return fn.apply(this, Array.prototype.slice.call(arguments, 1));
      }
    }, exact);
  }

  // The HTML structured-clone gates that some node tests probe;
  // we always claim feature-available since edge.js's compat is
  // designed to provide them.
  var hasCrypto = (function() {
    try { return !!require('crypto'); } catch (e) { return false; }
  })();

  globalThis.common = {
    mustCall: mustCall,
    mustCallAtLeast: mustCallAtLeast,
    mustNotCall: mustNotCall,
    mustSucceed: mustSucceed,
    hasCrypto: hasCrypto,
    // Node's common exposes some platform tags; default sensible values
    // and let ported tests skip in setups where they don't apply.
    isWindows: false,
    isMainThread: (function() {
      try { return require('worker_threads').isMainThread; }
      catch (e) { return true; }
    })(),
    // Some tests do `common.platformTimeout(ms)` for slow CI; just
    // pass through.
    platformTimeout: function(ms) { return ms; },
    // Tests use this to inject a small async delay.
    skip: function(reason) {
      console.log('1..0 # SKIP ' + (reason || ''));
      try { process.exit(0); } catch (e) { void e; }
    },
  };
})();
