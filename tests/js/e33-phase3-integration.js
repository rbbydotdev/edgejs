// Phase 3 integration test: exercises workerData + postMessage +
// terminate + error event together to prove all four sub-phases
// (3a-3d) work end-to-end as a unified API surface.
//
// Has NO harness-args sidecar — relies on worker-threads-per-thread
// being in defaultBrowserPolicies (phase 3d).
//
// Uses __edgeSpawnNodeWorker directly since `new Worker(code, { eval: true })`
// needs eval-mode support in EdgeWorkerImpl (Phase 5 prerequisite —
// see commit message for the followup design).
require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

if (!globalThis.__edgeSpawnNodeWorker) { console.log('FAIL: prereq'); process.exit(1); }

// === Test 1: workerData round-trip (3a) ===
const wd = { initialPayload: 'from-parent', count: 42 };
const wdBytes = globalThis.__edgePackPostMessage(wd);

let childReport = null;
let exitCode = null;
let errorReceived = null;

globalThis.__edgeDispatchUserWorkerExit = (_w, c) => { exitCode = c; };
globalThis.__edgeDispatchMessageFromChild = (_w, bytes) => {
  const data = globalThis.__edgeUnpackPostMessage(bytes);
  if (data && data.__edgeWorkerError === true) {
    errorReceived = data.error;
    return;
  }
  if (data && data.kind === 'report') childReport = data;
};

// Bootstrap: reports workerData, demonstrates postMessage from child,
// then schedules an async throw to test 'error' (3c).
const bootstrap = `
  var wt = require('worker_threads');
  var wd = wt.workerData;
  var bytes = globalThis.__edgePackPostMessage({
    kind: 'report',
    sawWorkerData: wd !== undefined,
    payload: wd && wd.initialPayload,
    count: wd && wd.count,
  });
  globalThis.__edgePostMessageFromWorker(bytes);
  // Schedule async throw to verify 3c uncaughtException path.
  setTimeout(function() { throw new Error('phase3-integration-async-throw'); }, 200);
  var k = setInterval(function() {}, 100);
`;

globalThis.__edgeSpawnNodeWorker(bootstrap, wdBytes);

setTimeout(() => {
  // 3a checks
  ok('child_workerData_received', childReport && childReport.sawWorkerData === true);
  ok('child_workerData_payload', childReport && childReport.payload === 'from-parent');
  ok('child_workerData_count', childReport && childReport.count === 42);
  // 3b/3c checks (child threw + exited)
  ok('child_exited', exitCode !== null);
  ok('child_exit_nonzero', exitCode === 1);
  ok('error_received', errorReceived !== null);
  ok('error_message_matches', errorReceived && /phase3-integration-async-throw/.test(errorReceived.message));
  ok('error_has_stack', errorReceived && typeof errorReceived.stack === 'string');
  // 3d check (no harness-args present, policy globals available)
  ok('policy_default_active', typeof globalThis.__edgeAllocPortId === 'function');
  process.exit(0);
}, 3000);
