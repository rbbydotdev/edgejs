// Worker_threads phase 2 — direct probe of the postMessage roundtrip.
//
// Bypasses the policy patch and uses the wasm-side globals
// (installed by browser-target/src/worker.ts) directly.  Exercises
// every link in the parent ↔ child chain:
//
//   parent wasm: __edgePostMessageToWorker(workerId, packedBytes)
//   → sync RPC OP_WORKER_POST_MESSAGE_TO_CHILD → parent host
//   → postMessage main {worker-message-to-child, workerId, bytes}
//   → postMessage child host {deliver-message-to-child, bytes}
//   → reverseRPC OP_DELIVER_MESSAGE_TO_CHILD → child wasm
//   → globalThis.__edgeDispatchMessageToChild(bytes)
//
//   child wasm: __edgePostMessageFromWorker(packedBytes)
//   → sync RPC OP_WORKER_POST_MESSAGE_TO_PARENT → child host
//   → postMessage main {worker-message-to-parent, childHostWorkerId, bytes}
//   → main looks up parent host via userWorkers registry
//   → postMessage parent host {deliver-message-from-child, workerId, bytes}
//   → reverseRPC OP_DELIVER_MESSAGE_FROM_CHILD → parent wasm
//   → globalThis.__edgeDispatchMessageFromChild(workerId, bytes)
//
// Also exercises the marshal hookup (cross-context-marshal via the
// __edge{Pack,Unpack}PostMessage globals) by sending a mixed-type
// object: string, number, array of ints, nested plain object.
//
// Phase 2 will additionally add a sibling test that uses the actual
// `new Worker()` API via the worker-threads-per-thread policy patch —
// once file-mode FS visibility (or inline-source eval mode) lands.

if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') {
  console.error('FAIL: __edgeSpawnNodeWorker not installed');
  process.exit(1);
}
if (typeof globalThis.__edgePackPostMessage !== 'function') {
  console.error('FAIL: __edgePackPostMessage not installed');
  process.exit(1);
}
if (typeof globalThis.__edgePostMessageToWorker !== 'function') {
  console.error('FAIL: __edgePostMessageToWorker not installed');
  process.exit(1);
}

let receivedFromChild = null;
let childExitCode = null;

globalThis.__edgeDispatchMessageFromChild = (workerId, bytes) => {
  receivedFromChild = globalThis.__edgeUnpackPostMessage(bytes);
  void workerId;
};
globalThis.__edgeDispatchUserWorkerExit = (_workerId, code) => {
  childExitCode = code;
};

// Child bootstrap: install the receive-side dispatcher, but defer all
// actual work (reply, exit) to the natural libuv stack via a polling
// setInterval.  Two reasons:
//   1. Without something pending on libuv, _start returns immediately
//      after the synchronous dispatcher install and the child exits
//      with code 0 BEFORE the parent gets a chance to send.  The
//      reverse-RPC server runs on a JSPI/Atomics path that doesn't
//      register with libuv as a pending handle.
//   2. NOTES.md `worker-threads-reverse-rpc-exit-fragility`:
//      process.exit / setTimeout-to-exit called from inside the
//      reverse-RPC handler stack doesn't propagate cleanly.  Better
//      to set a flag and exit on the natural libuv timer callback.
const childBootstrap = `
  var pendingBytes = null;
  globalThis.__edgeDispatchMessageToChild = function(bytes) {
    pendingBytes = bytes;
  };
  var interval = setInterval(function() {
    if (pendingBytes !== null) {
      clearInterval(interval);
      var data = globalThis.__edgeUnpackPostMessage(pendingBytes);
      var reply = { echoed: data, fromChild: true };
      var replyBytes = globalThis.__edgePackPostMessage(reply);
      globalThis.__edgePostMessageFromWorker(replyBytes);
      setTimeout(function() { process.exit(0); }, 50);
    }
  }, 50);
  setTimeout(function() { process.exit(3); }, 8000);
`;

const workerId = globalThis.__edgeSpawnNodeWorker(childBootstrap);
console.log('spawned worker id:', workerId);

// Give the child wasm a beat to boot + register its dispatcher before
// the parent sends.  100 ms is comfortably above E24's measured 25-35ms
// steady-state spawn + a real edge.js bootstrap.
setTimeout(() => {
  const send = { ping: 'hello', n: 42, list: [1, 2, 3], nested: { k: 'v' } };
  const bytes = globalThis.__edgePackPostMessage(send);
  globalThis.__edgePostMessageToWorker(workerId, bytes);
}, 300);

const startMs = Date.now();
const poll = () => {
  if (receivedFromChild !== null && childExitCode !== null) {
    console.log('got from child:', JSON.stringify(receivedFromChild));
    console.log('child exit code:', childExitCode);
    process.exit(0);
  } else if (Date.now() - startMs > 6000) {
    console.error(
      'FAIL: incomplete after 6s. received=' +
      JSON.stringify(receivedFromChild) +
      ' exitCode=' + childExitCode,
    );
    process.exit(2);
  } else {
    setTimeout(poll, 100);
  }
};
setTimeout(poll, 500);
