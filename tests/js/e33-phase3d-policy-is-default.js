// Phase 3d verification: worker-threads-per-thread is in
// defaultBrowserPolicies, so worker_threads features (workerData
// unmarshal, terminate, error event, port-transfer infra) work
// WITHOUT requiring `?policies=worker-threads-per-thread` in the
// harness-args.
//
// This test has NO harness-args sidecar — it relies on the policy
// being default.  If the promotion is ever reverted, this test
// will fail (the global will be undefined).
require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

ok('has_allocPortId', typeof globalThis.__edgeAllocPortId === 'function');
ok('has_makePortStub', typeof globalThis.__edgeMakePortStub === 'function');
ok('has_siblingMap', globalThis.__edgePortSiblingMap != null);
ok('has_isLikelyMessagePort', typeof globalThis.__edgeIsLikelyMessagePort === 'function');
ok('has_workersById', globalThis.__edgeWorkersById != null);

const wt = require('worker_threads');
ok('MC_wrapped', wt.MessageChannel && wt.MessageChannel.__edgeWrapped === true);
process.exit(0);
