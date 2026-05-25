// Phase 5: eval-mode Worker support.
//
// Real Node accepts `new Worker(code, { eval: true })` where the first
// arg is JavaScript source rather than a path/URL.  Prior to Phase 5,
// EdgeWorkerImpl treated the first arg as a path and tried to
// require() the code string, which silently failed.
//
// EdgeWorkerInstanceTracker (post-patch) now intercepts options.eval
// BEFORE super() runs and stashes the code on globalThis.__edgePendingEvalCode.
// EdgeWorkerImpl (pre-patch) picks it up and synthesizes the bootstrap
// directly, skipping the urlToSrcPath path entirely.
//
// This test exercises the whole surface: spawn → workerData → child runs
// the eval code → child posts back → child exits cleanly.
const { Worker } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

let messageReceived = null;
let exitCode = null;
let errorSeen = null;

const childCode = `
  var wt = require('worker_threads');
  // Confirm workerData arrived alongside eval-mode.
  var wd = wt.workerData;
  wt.parentPort.postMessage({
    fromEval: true,
    sawWorkerData: wd !== undefined,
    payload: wd && wd.payload,
  });
  setTimeout(function() { process.exit(0); }, 100);
`;

const w = new Worker(childCode, {
  eval: true,
  workerData: { payload: 'eval-mode-ok' },
});

w.on('message', (m) => { messageReceived = m; });
w.on('error', (e) => { errorSeen = e; });
w.on('exit', (code) => { exitCode = code; });

setTimeout(() => {
  ok('no_error', errorSeen === null);
  ok('message_received', messageReceived !== null);
  ok('message_fromEval', messageReceived && messageReceived.fromEval === true);
  ok('workerData_received', messageReceived && messageReceived.sawWorkerData === true);
  ok('workerData_payload', messageReceived && messageReceived.payload === 'eval-mode-ok');
  ok('child_exited_zero', exitCode === 0);
  process.exit(0);
}, 2000);
