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
// This test runs against the bare wasm-side globals (not the
// worker-threads-per-thread policy), so the child bootstrap below has
// to install its own __edgeDispatchMessageToChild handler.  The
// policy patch's parentPort keepalive isn't in play here — but the
// setImmediate wrapping on the reverse-RPC dispatch is, which lets
// the child call `process.exit` directly from inside the message
// handler and have it propagate through _start's exit signal path
// cleanly.

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

// Child bootstrap: install the message dispatcher plus a libuv-visible
// keepalive ticker.  The ticker is a short-period (100 ms) setInterval
// — it serves two roles:
//   1. Keeps libuv alive (uv_timer_t is a pending handle).
//   2. Actively drives libuv loop iterations so the reverse-RPC
//      handler's setImmediate (added in worker.ts) gets a chance to
//      run — without ticks, poll_oneoff would park indefinitely.
//
// The worker-threads-per-thread policy patch installs a similar (but
// longer-period) keepalive on parentPort once a 'message' listener
// is registered.  This test bypasses the policy and uses the raw
// __edgeDispatchMessageToChild global, so it has to manage its own
// keepalive.
//
// The handler calls process.exit(0) directly: the setImmediate wrap
// in worker.ts puts dispatch on libuv's check-phase tick, so
// ExitSignal propagates through _start's normal exit-handler path
// instead of being swallowed by the reverse-RPC handler's try/catch.
const childBootstrap = `
  var keepalive = setInterval(function() {}, 100);
  globalThis.__edgeDispatchMessageToChild = function(bytes) {
    var data = globalThis.__edgeUnpackPostMessage(bytes);
    var reply = { echoed: data, fromChild: true };
    var replyBytes = globalThis.__edgePackPostMessage(reply);
    globalThis.__edgePostMessageFromWorker(replyBytes);
    clearInterval(keepalive);
    process.exit(0);
  };
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
