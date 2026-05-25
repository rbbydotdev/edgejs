// e33 step 3: end-to-end bidirectional port message via transferred port.
//
// Parent: creates MessageChannel, transfers port1 to child with greeting,
// listens on port2.
// Child: receives stub from message, calls stub.postMessage('hello-back').
// Parent: port2.on('message') fires with 'hello-back', test passes.
//
// Routing path:
//   child stub.postMessage('hello-back')
//     → __edgePackPostMessage({__edgePortMsg, targetPortId, payload})
//     → __edgePostMessageFromWorker(bytes)
//     → host RPC → main thread → parent host → reverse-RPC → parent wasm
//     → __edgeDispatchMessageFromChild detects __edgePortMsg envelope
//     → looks up __edgePortsByGlobalId.get(targetPortId) → ch.port1
//     → calls ch.port1.postMessage(payload) — C++ binding queues on ch.port2
//     → ch.port2.on('message') fires with 'hello-back'

if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') {
  console.error('FAIL: __edgeSpawnNodeWorker not installed');
  process.exit(1);
}

const { MessageChannel } = require('worker_threads');

// Install the port-transfer infra inline (mirrors what
// worker-threads-per-thread policy does) since this test runs without
// the policy enabled.  Idempotent globals.
globalThis.__edgePortIdNext = globalThis.__edgePortIdNext || 1;
globalThis.__edgePortsByGlobalId = globalThis.__edgePortsByGlobalId || new Map();
function __edgeAllocPortId(port) {
  const id = globalThis.__edgePortIdNext++;
  globalThis.__edgePortsByGlobalId.set(id, port);
  return id;
}

let childExitCode = null;
globalThis.__edgeDispatchUserWorkerExit = (_wid, code) => { childExitCode = code; };

// Parent-side child-message dispatcher: detect __edgePortMsg envelope,
// route to local port.
globalThis.__edgeDispatchMessageFromChild = (_workerId, bytes) => {
  // Use the same decodePort behavior the policy would.  For parent-side
  // (sender of transfer), we don't expect ports to come back as stubs
  // in non-envelope messages in this test, so a minimal decoder is OK.
  const data = globalThis.__edgeUnpackPostMessage(bytes, (id) => ({ __edgeStub: true, id }));
  if (data && typeof data === 'object' && data.__edgePortMsg === true) {
    const localPort = globalThis.__edgePortsByGlobalId.get(data.targetPortId);
    if (localPort && typeof localPort.postMessage === 'function') {
      try { localPort.postMessage(data.payload); } catch (e) { void e; }
    }
  }
};

// Child bootstrap: receives stub, calls stub.postMessage with reply.
const childBootstrap = `
  var keepalive = setInterval(function() {}, 100);
  globalThis.__edgeDispatchMessageToChild = function(bytes) {
    var stubFactory = function(portId) {
      var stub = {
        on: function() { return stub; },
        once: function() { return stub; },
        off: function() { return stub; },
        emit: function() { return true; },
        removeAllListeners: function() { return stub; },
        listenerCount: function() { return 0; },
        postMessage: function(payload) {
          var envelope = {
            __edgePortMsg: true,
            targetPortId: portId,
            payload: payload,
          };
          var b = globalThis.__edgePackPostMessage(envelope);
          globalThis.__edgePostMessageFromWorker(b);
        },
        start: function() {},
        close: function() {},
        ref: function() { return stub; },
        unref: function() { return stub; },
        hasRef: function() { return true; },
      };
      Object.defineProperty(stub, '__edgePortStub', { value: true });
      Object.defineProperty(stub, '__edgeGlobalPortId', { value: portId });
      return stub;
    };
    var data = globalThis.__edgeUnpackPostMessage(bytes, stubFactory);
    // Reply via the transferred port stub.
    if (data && data.transferredPort && typeof data.transferredPort.postMessage === 'function') {
      data.transferredPort.postMessage('hello-back-from-child');
    }
    // Give the message a beat to travel, then exit.
    setTimeout(function() {
      clearInterval(keepalive);
      process.exit(0);
    }, 500);
  };
`;

const workerId = globalThis.__edgeSpawnNodeWorker(childBootstrap);
const ch = new MessageChannel();

let receivedOnPort2 = null;
ch.port2.on('message', (data) => {
  receivedOnPort2 = data;
});

setTimeout(() => {
  // Transfer ch.port1 to child via the marshal layer (simulates what
  // Worker.prototype.postMessage would do under the policy).
  const portId = __edgeAllocPortId(ch.port1);
  const assignId = (obj) => (obj === ch.port1 ? portId : null);
  const value = { greeting: 'hi-from-parent', transferredPort: ch.port1 };
  const bytes = globalThis.__edgePackPostMessage(value, [ch.port1], assignId);
  globalThis.__edgePostMessageToWorker(workerId, bytes);
}, 300);

const startMs = Date.now();
const poll = () => {
  if (receivedOnPort2 !== null && childExitCode !== null) {
    function ok(label, cond) { console.log(label + ':' + (cond ? 'PASS' : 'FAIL')); }
    ok('received_on_port2', receivedOnPort2 === 'hello-back-from-child');
    ok('child_exit_0', childExitCode === 0);
    ch.port1.close();
    ch.port2.close();
    process.exit(0);
  } else if (Date.now() - startMs > 6000) {
    console.error('FAIL: timeout received=' + JSON.stringify(receivedOnPort2) + ' exit=' + childExitCode);
    process.exit(2);
  } else {
    setTimeout(poll, 100);
  }
};
setTimeout(poll, 500);
