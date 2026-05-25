// Phase 3a: worker_threads.workerData round-trip.
//
// Parent: new Worker(_, { workerData: { complex: 'value' } })
//   → policy wrapper marshals via __edgePackPostMessage
//   → EdgeWorkerImpl reads __edgePendingWorkerData
//   → __edgeSpawnNodeWorker(boot, bytes)
//   → main.ts spawnUserWorker forwards bytes
//   → child wasm's `edge-user-worker-bootstrap` handler stashes on
//     globalThis.__edgeUserWorkerDataBytes
//   → child policy's WORKER_THREADS_POST_PATCH unmarshals + exposes
//     as require('worker_threads').workerData
//
// Test bypasses real `new Worker(filename)` (needs file path) by
// driving the marshal layer + spawn directly — same code path the
// EdgeWorkerImpl uses internally.
require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

if (!globalThis.__edgeSpawnNodeWorker) { console.log('FAIL: prereq'); process.exit(1); }

// Marshal a complex workerData value
const workerData = {
  greeting: 'hello-worker',
  count: 7,
  nested: { items: [1, 2, 3] },
  buf: new Uint8Array([10, 20, 30]),
};
const wdBytes = globalThis.__edgePackPostMessage(workerData);

const bootstrap = `
  // Mirror child-side WORKER_THREADS_POST_PATCH's workerData wiring.
  var wt = require('worker_threads');
  var wdBytes = globalThis.__edgeUserWorkerDataBytes;
  var report = {
    hasBytes: wdBytes != null,
    bytesLen: wdBytes ? wdBytes.byteLength : 0,
    wt_workerData: wt.workerData,  // policy patch should expose this
  };
  var b = globalThis.__edgePackPostMessage(report);
  globalThis.__edgePostMessageFromWorker(b);
  setTimeout(function() { process.exit(0); }, 200);
`;

let childReport = null, exitCode = null;
globalThis.__edgeDispatchUserWorkerExit = (_w, c) => { exitCode = c; };
globalThis.__edgeDispatchMessageFromChild = (_w, bytes) => {
  childReport = globalThis.__edgeUnpackPostMessage(bytes);
};

globalThis.__edgeSpawnNodeWorker(bootstrap, wdBytes);

setTimeout(() => {
  ok('child_reported', childReport !== null);
  ok('child_received_bytes', childReport && childReport.hasBytes === true);
  ok('child_bytes_nonempty', childReport && childReport.bytesLen > 0);
  const wd = childReport && childReport.wt_workerData;
  ok('wt_workerData_object', wd && typeof wd === 'object');
  ok('greeting', wd && wd.greeting === 'hello-worker');
  ok('count', wd && wd.count === 7);
  ok('nested_items', wd && wd.nested && Array.isArray(wd.nested.items) && wd.nested.items[2] === 3);
  ok('buf_is_uint8', wd && wd.buf instanceof Uint8Array);
  ok('buf_content', wd && wd.buf && wd.buf[0] === 10 && wd.buf[2] === 30);
  ok('child_exit_0', exitCode === 0);
  process.exit(0);
}, 2000);
