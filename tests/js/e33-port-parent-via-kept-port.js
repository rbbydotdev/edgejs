// Item 1 (e33): parent→child via the parent-side kept port.
//
// Before this item: after transferring ch.port1 to child, parent
// calling ch.port2.postMessage('x') queued 'x' on ch.port1 via the
// C++ binding (since C++ doesn't know about the transfer).  port1 is
// in parent (neutered), so the message was effectively stuck —
// child's stub never saw it.
//
// After item 1: at transfer time, the kept sibling's postMessage is
// rewired to envelope-route to the transferred port's stub on the
// child.  Bidirectional flow:
//   parent  ch.port2.postMessage('hi')
//     → rewired sibling postMessage → envelope
//     → __edgePostMessageToWorker(childId, bytes)
//     → child __edgeDispatchMessageToChild sees __edgePortMsg envelope
//     → emits 'message' on the local stub
//   child   stub.on('message', cb) fires; cb does stub.postMessage('reply')
//     → envelope → __edgePostMessageFromWorker
//     → parent __edgeDispatchMessageFromChild sees envelope
//     → entry.deliver('reply') → ch.port1.original.postMessage('reply')
//     → C++ queues on sibling (ch.port2) → ch.port2.on('message') fires
const { MessageChannel } = require('worker_threads');

function ok(label, cond) { console.log(label + ':' + (cond ? 'PASS' : 'FAIL')); }

if (typeof globalThis.__edgeAllocPortId !== 'function') {
  console.log('FAIL: policy not active');
  process.exit(1);
}
if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') {
  console.log('FAIL: __edgeSpawnNodeWorker not installed');
  process.exit(1);
}

// Confirm the MessageChannel wrap is active (item 1 prerequisite).
ok('MessageChannel_wrapped', MessageChannel.__edgeWrapped === true);

const ch = new MessageChannel();
ok('sibling_tracked_p1_to_p2', globalThis.__edgePortSiblingMap.get(ch.port1) === ch.port2);
ok('sibling_tracked_p2_to_p1', globalThis.__edgePortSiblingMap.get(ch.port2) === ch.port1);

// Child bootstrap: registers stub, listens, replies, exits.
const childBootstrap = `
  var keepalive = setInterval(function() {}, 100);
  globalThis.__edgePortStubsByGlobalId = globalThis.__edgePortStubsByGlobalId || new Map();
  if (typeof globalThis.__edgeMakePortStub !== 'function') {
    globalThis.__edgeMakePortStub = function(portId) {
      var listeners = { message: [], messageerror: [], close: [] };
      var stub = {
        on: function(ev, cb) {
          if (!listeners[ev]) listeners[ev] = [];
          listeners[ev].push(cb);
          return stub;
        },
        once: function(ev, cb) { return stub.on(ev, cb); },
        off: function() { return stub; },
        emit: function(ev) {
          var args = Array.prototype.slice.call(arguments, 1);
          var ls = listeners[ev] || [];
          for (var i = 0; i < ls.length; i++) {
            try { ls[i].apply(null, args); } catch (e) { void e; }
          }
          return ls.length > 0;
        },
        removeAllListeners: function(ev) {
          if (ev) listeners[ev] = []; else listeners = { message: [], messageerror: [], close: [] };
          return stub;
        },
        listenerCount: function(ev) { return (listeners[ev] || []).length; },
        postMessage: function(payload) {
          var env = { __edgePortMsg: true, targetPortId: portId, payload: payload };
          var b = globalThis.__edgePackPostMessage(env);
          globalThis.__edgePostMessageFromWorker(b);
        },
        start: function() {}, close: function() {},
        ref: function() { return stub; }, unref: function() { return stub; },
        hasRef: function() { return true; },
      };
      Object.defineProperty(stub, '__edgePortStub', { value: true });
      Object.defineProperty(stub, '__edgeGlobalPortId', { value: portId });
      globalThis.__edgePortStubsByGlobalId.set(portId, stub);
      return stub;
    };
  }

  var stub = null;
  globalThis.__edgeDispatchMessageToChild = function(bytes) {
    var data = globalThis.__edgeUnpackPostMessage(bytes, function(portId) {
      var existing = globalThis.__edgePortStubsByGlobalId.get(portId);
      if (existing) return existing;
      return globalThis.__edgeMakePortStub(portId);
    });
    // Envelope path (item 1: parent sending via kept port to our stub)
    if (data && data.__edgePortMsg === true) {
      var s = globalThis.__edgePortStubsByGlobalId.get(data.targetPortId);
      if (s && typeof s.emit === 'function') s.emit('message', data.payload);
      return;
    }
    // Initial message with transferred port reference
    if (data && data.type === 'init' && data.transferredPort) {
      stub = data.transferredPort;
      stub.on('message', function(m) {
        // Reply once
        stub.postMessage('reply-from-child:' + m);
        clearInterval(keepalive);
        // Give the reply a beat to travel before exiting.
        setTimeout(function() { process.exit(0); }, 200);
      });
    }
  };
`;

const workerId = globalThis.__edgeSpawnNodeWorker(childBootstrap);

let childExitCode = null;
globalThis.__edgeDispatchUserWorkerExit = (_wid, code) => { childExitCode = code; };

// Listen on kept port
let parentReceived = null;
ch.port2.on('message', (m) => { parentReceived = m; });

setTimeout(() => {
  // Allocate port-ID for ch.port1 with destinationWorkerId = workerId.
  // This neuters ch.port1 AND rewires ch.port2.postMessage to envelope-
  // route to that worker.
  const portId = globalThis.__edgeAllocPortId(ch.port1, workerId);
  ok('portId_allocated', typeof portId === 'number' && portId > 0);
  ok('port1_neutered', ch.port1.__edgeNeutered === true);
  ok('port2_rewired', ch.port2.__edgeSiblingRewired === true);

  // Send initial value transferring port-ref
  const assignId = (obj) => (obj === ch.port1 ? portId : null);
  const bytes = globalThis.__edgePackPostMessage(
    { type: 'init', transferredPort: ch.port1 },
    [ch.port1],
    assignId,
  );
  globalThis.__edgePostMessageToWorker(workerId, bytes);
}, 300);

// After child has received init, send via kept port (uses rewired sibling)
setTimeout(() => {
  ch.port2.postMessage('hi-from-parent-via-kept-port');
}, 800);

const startMs = Date.now();
const poll = () => {
  if (parentReceived !== null && childExitCode !== null) {
    ok('parent_got_reply', parentReceived === 'reply-from-child:hi-from-parent-via-kept-port');
    ok('child_exit_0', childExitCode === 0);
    try { ch.port2.close(); } catch (e) { void e; }
    process.exit(0);
  } else if (Date.now() - startMs > 6000) {
    console.log('TIMEOUT parentReceived=' + JSON.stringify(parentReceived) + ' exit=' + childExitCode);
    process.exit(2);
  } else {
    setTimeout(poll, 100);
  }
};
setTimeout(poll, 1200);
