// e34 task #11: top-level sync throw in a Worker now fires 'error'
// AND exits non-zero (matches Node spec).
//
// Pre-fix: edge.js's -e evaluator swallowed top-level sync throws,
// exit code was 0, no 'error' event.  Async throws via setTimeout
// worked because process.on('uncaughtException') caught them — but
// sync throws never reached that handler.
//
// Fix: EdgeWorkerImpl wraps the user bootstrap with try/catch that
// directly sends a WORKER_ERROR control envelope and exits 1.  This
// works even if the throw happens before require('worker_threads')
// (the policy's uncaughtException handler only attaches there).
const { Worker } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

let receivedError = null;
let exitCode = null;
let errorTimestamp = null;
let exitTimestamp = null;

const childCode = `
  // Throw IMMEDIATELY at top level, BEFORE require('worker_threads').
  // Pre-fix this exited 0 silently.  Post-fix the wrapper catches and
  // sends WORKER_ERROR.
  throw new Error('top-level-sync-throw-from-worker');
`;

const w = new Worker(childCode, { eval: true });
w.on('error', (e) => { receivedError = e; errorTimestamp = Date.now(); });
w.on('exit', (c) => { exitCode = c; exitTimestamp = Date.now(); });

setTimeout(() => {
  ok('error_received', receivedError !== null);
  ok('error_is_Error', receivedError instanceof Error);
  ok('error_message_matches', receivedError && /top-level-sync-throw-from-worker/.test(receivedError.message));
  ok('error_has_stack', receivedError && typeof receivedError.stack === 'string' && receivedError.stack.length > 0);
  ok('exit_fired', exitCode !== null);
  ok('exit_code_nonzero', exitCode !== null && exitCode !== 0);
  ok('error_before_or_equal_exit',
    errorTimestamp !== null && exitTimestamp !== null && errorTimestamp <= exitTimestamp);
  process.exit(0);
}, 3000);
