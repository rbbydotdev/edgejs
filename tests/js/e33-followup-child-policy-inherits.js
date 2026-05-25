// Followup e33: verify child workers inherit parent's `?policies=...`.
// Before fix: child booted with only defaultBrowserPolicies regardless
// of the parent's URL params.  After: child gets the same extraPolicies
// passed via the spawn payload, so policy patches (e.g.
// worker-threads-per-thread) are active on children too.
require('worker_threads');
let childReport = null;
let exitCode = null;
globalThis.__edgeDispatchUserWorkerExit = (_w, c) => { exitCode = c; };
globalThis.__edgeDispatchMessageFromChild = (_w, bytes) => {
  childReport = globalThis.__edgeUnpackPostMessage(bytes);
};

const bootstrap = `
  // require worker_threads FIRST — that triggers the policy's post-patch
  // which installs the port-transfer helpers.  Checking the globals
  // BEFORE require would see the pre-patch state.
  var wt;
  try { wt = require('worker_threads'); } catch (e) {}
  var report = {
    // Note: child-side patches expose helpers as the SAME global names
    // as parent-side (the internal locals are __edgeAllocPortIdChild
    // / __edgeMakePortStubChild but the globalThis bindings are the
    // unsuffixed names).  Test the bindings, not the locals.
    has_allocPortId: typeof globalThis.__edgeAllocPortId === 'function',
    has_makePortStub: typeof globalThis.__edgeMakePortStub === 'function',
    has_siblingMap: globalThis.__edgePortSiblingMap != null,
    has_isLikelyMessagePort: typeof globalThis.__edgeIsLikelyMessagePort === 'function',
    has_hostWorkerId: typeof globalThis.__edgeHostWorkerId === 'number',
    isUserWorker: globalThis.__edgeIsUserWorker === true,
    has_postFromWorker: typeof globalThis.__edgePostMessageFromWorker === 'function',
    MC_wrapped: wt && wt.MessageChannel && wt.MessageChannel.__edgeWrapped === true,
  };
  var bytes = globalThis.__edgePackPostMessage(report);
  globalThis.__edgePostMessageFromWorker(bytes);
  setTimeout(function() { process.exit(0); }, 300);
`;
globalThis.__edgeSpawnNodeWorker(bootstrap);

function ok(label, cond) { console.log(label + ':' + (cond ? 'PASS' : 'FAIL')); }

setTimeout(() => {
  ok('child_reported', childReport !== null);
  ok('child_has_allocPortId', childReport && childReport.has_allocPortId === true);
  ok('child_has_makePortStub', childReport && childReport.has_makePortStub === true);
  ok('child_has_siblingMap', childReport && childReport.has_siblingMap === true);
  ok('child_has_isLikelyMessagePort', childReport && childReport.has_isLikelyMessagePort === true);
  ok('child_has_hostWorkerId', childReport && childReport.has_hostWorkerId === true);
  ok('child_isUserWorker', childReport && childReport.isUserWorker === true);
  ok('child_has_postFromWorker', childReport && childReport.has_postFromWorker === true);
  ok('child_MC_wrapped', childReport && childReport.MC_wrapped === true);
  ok('child_exit_0', exitCode === 0);
  process.exit(0);
}, 2000);
