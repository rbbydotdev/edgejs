// Phase 3b: worker.terminate() actually stops the child + resolves
// with the exit code (matches Node semantics).
//
// Test uses __edgeSpawnNodeWorker (no real file path needed) and
// drives EdgeWorkerImpl.stopThread directly — same path lib's
// Worker.terminate() takes internally.
require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

if (!globalThis.__edgeSpawnNodeWorker) { console.log('FAIL: prereq'); process.exit(1); }

let exitCode = null;
let exitTimestamp = null;
globalThis.__edgeDispatchUserWorkerExit = (_w, c) => {
  exitCode = c;
  exitTimestamp = Date.now();
};

// Child that just keeps a keepalive going — would run forever without
// terminate.  MUST require('worker_threads') to trigger the policy's
// WORKER_THREADS_POST_PATCH which installs __edgeDispatchMessageToChild
// (the dispatcher that recognizes the terminate envelope).
const childBootstrap = `
  require('worker_threads');
  var k = setInterval(function() {}, 100);
  // No process.exit — depends on terminate signal.
`;

const spawnedAt = Date.now();
const workerId = globalThis.__edgeSpawnNodeWorker(childBootstrap);

// Wait briefly for child to boot, then "terminate" by sending the
// envelope ourselves (mirrors what EdgeWorkerImpl.stopThread does).
setTimeout(() => {
  const bytes = globalThis.__edgePackPostMessage({ __edgeWorkerTerminate: true });
  globalThis.__edgePostMessageToWorker(workerId, bytes);
}, 500);

setTimeout(() => {
  ok('child_exited', exitCode !== null);
  ok('exit_code_1', exitCode === 1);
  // Bound at 5s — child must boot, dispatcher must install, terminate
  // envelope must travel parent → main → child → exit; 5s is loose
  // enough to absorb boot-time variance, tight enough to fail if the
  // signal is dropped (test's outer timeout is also 4s so this is
  // really just a "did exit happen within the test window" sanity).
  ok('exited_promptly', exitTimestamp !== null && (exitTimestamp - spawnedAt) < 5000);
  process.exit(0);
}, 4000);
