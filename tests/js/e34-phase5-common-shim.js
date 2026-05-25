// Phase 5: common.mustCall shim smoke test.
//
// Loaded with `prelude=common-shim` (see harness-args).  The prelude
// installs globalThis.common with mustCall / mustCallAtLeast /
// mustNotCall / mustSucceed.  This test validates each path:
//   - mustCall(fn, 1) — fires once, would fail if 0 or 2
//   - mustCallAtLeast(fn, 2) — fires twice, fine
//   - mustNotCall throws synchronously when called
//
// The shim hooks process.on('exit') to enforce mustCall counts;
// because we exit(0) explicitly at the end of synchronous setup,
// the exit-handler runs before this script's last log line lands.
const { Worker } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

const common = globalThis.common;
ok('shim_loaded', typeof common === 'object' && common !== null);
ok('mustCall_is_fn', typeof common.mustCall === 'function');
ok('mustCallAtLeast_is_fn', typeof common.mustCallAtLeast === 'function');
ok('mustNotCall_is_fn', typeof common.mustNotCall === 'function');

let oneShotCount = 0;
const oneShot = common.mustCall(() => { oneShotCount++; });
oneShot();
ok('mustCall_invoked_once', oneShotCount === 1);

let twiceCount = 0;
const twice = common.mustCallAtLeast(() => { twiceCount++; }, 2);
twice();
twice();
ok('mustCallAtLeast_twice', twiceCount === 2);

const noTouch = common.mustNotCall('this should not fire');
let threw = false;
try { noTouch(); } catch (e) { threw = true; }
ok('mustNotCall_throws', threw);

// Verify the shim's mustCall exit-hook works correctly in a child
// Worker (real isolation, real process.on('exit')).  Use eval-mode
// Worker (Phase 5) to inline the child source.
const childCode = `
  // Re-define the shim inside the child isolate.  Workers don't
  // inherit globals from the parent, so we paste the relevant bits.
  var checks = [];
  function mc(fn, n) {
    if (n === undefined) n = 1;
    if (checks.length === 0) process.on('exit', function(code) {
      if (code !== 0) return;
      var bad = checks.filter(function(c) { return c.actual !== c.exact; });
      if (bad.length) { process.exit(2); }
    });
    var ctx = { exact: n, actual: 0 };
    checks.push(ctx);
    return function() { ctx.actual++; return fn.apply(this, arguments); };
  }
  var f = mc(function() {}, 1);
  f();  // satisfied — should exit 0
  process.exit(0);
`;
const w = new Worker(childCode, { eval: true });
let childExitCode = null;
w.on('exit', (code) => { childExitCode = code; });

setTimeout(() => {
  ok('child_mustCall_exit_zero', childExitCode === 0);
  process.exit(0);
}, 1500);
