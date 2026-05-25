// Phase 3c: uncaught child throw fires 'error' event on Worker BEFORE
// 'exit' event, with a proper Error instance (name/message/stack).
//
// Pre-fix: child throws → only 'exit' fires with code 1, no 'error'.
// Post-fix: 'error' fires first with the unpacked Error, then 'exit'.
require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

if (!globalThis.__edgeSpawnNodeWorker) { console.log('FAIL: prereq'); process.exit(1); }

let receivedError = null;
let exitCode = null;
let errorTimestamp = null;
let exitTimestamp = null;

globalThis.__edgeDispatchUserWorkerExit = (wid, code) => {
  void wid;
  exitCode = code;
  exitTimestamp = Date.now();
};

// e34+ spoof-proof control envelope: child sends WORKER_ERROR via the
// dedicated control kind byte (kind=0x03), never as user data, so this
// test installs __edgeDispatchControlFromChild rather than detecting
// inside __edgeDispatchMessageFromChild.
globalThis.__edgeDispatchControlFromChild = (wid, kind, controlBytes) => {
  void wid;
  if (kind !== globalThis.__edgePmKind.WORKER_ERROR) return;
  const e = globalThis.__edgeUnpackPostMessage(controlBytes) || {};
  const err = new Error(e.message || 'uncaught');
  if (e.name) err.name = e.name;
  if (e.stack) err.stack = e.stack;
  receivedError = err;
  errorTimestamp = Date.now();
};

// Child bootstrap throws ASYNCHRONOUSLY so process.on uncaughtException
// fires (sync throws are eaten by edge.js's -e eval wrapper before
// uncaughtException can see them).  The policy patch installs the
// uncaughtException handler which marshals + sends + exit(1).
//
// Need require('worker_threads') first to trigger the WORKER_THREADS_POST_PATCH
// (which is what installs the uncaughtException handler).
const childBootstrap = `
  require('worker_threads');
  setTimeout(function() {
    throw new Error('intentional-uncaught-from-child');
  }, 100);
  // Keepalive so the worker doesn't exit before the timeout fires.
  var k = setInterval(function() {}, 100);
`;

globalThis.__edgeSpawnNodeWorker(childBootstrap);

setTimeout(() => {
  ok('error_received', receivedError !== null);
  ok('error_is_Error_instance', receivedError instanceof Error);
  ok('error_message_contains_intentional', receivedError && /intentional-uncaught-from-child/.test(receivedError.message));
  ok('error_has_stack', receivedError && typeof receivedError.stack === 'string' && receivedError.stack.length > 0);
  ok('exit_fired', exitCode !== null);
  ok('exit_code_nonzero', exitCode !== null && exitCode !== 0);
  ok('error_before_exit', errorTimestamp !== null && exitTimestamp !== null && errorTimestamp <= exitTimestamp);
  process.exit(0);
}, 5000);
