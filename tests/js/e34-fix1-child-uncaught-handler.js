// e34 fix #1: child-side process.on('uncaughtException') handler MUST
// fire for top-level sync throws (Node spec).
//
// Pre-fix: bootstrap wrapper caught the throw before the user's handler
// could run.  Post-fix: wrapper re-emits 'uncaughtException' so the
// user handler runs FIRST (in spec order), then the wrapper sends
// WORKER_ERROR + exit.
const { Worker } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

let receivedError = null;
let receivedExit = null;
let childAcknowledged = null;

// Child sets up an uncaughtException handler that posts back a sentinel
// to the parent BEFORE the bootstrap throw fires.  If our re-emit
// works, the parent sees the sentinel AND the 'error' event.
const childCode = `
  var wt = require('worker_threads');
  process.on('uncaughtException', function(err) {
    // This MUST fire on sync throws per Node spec.
    wt.parentPort.postMessage({ handlerSawError: true, message: err.message });
  });
  throw new Error('fix1-top-level-sync');
`;

const w = new Worker(childCode, { eval: true });
w.on('message', (m) => { childAcknowledged = m; });
w.on('error', (e) => { receivedError = e; });
w.on('exit', (c) => { receivedExit = c; });

setTimeout(() => {
  ok('handler_ran_in_child', childAcknowledged !== null);
  ok('handler_saw_correct_error', childAcknowledged && childAcknowledged.handlerSawError === true);
  ok('handler_saw_message', childAcknowledged && childAcknowledged.message === 'fix1-top-level-sync');
  ok('parent_error_fired', receivedError !== null);
  ok('parent_error_message', receivedError && /fix1-top-level-sync/.test(receivedError.message));
  ok('exit_code_one', receivedExit === 1);
  process.exit(0);
}, 3000);
