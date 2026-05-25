// Item 2 (e33) MVP: child A creates a MessageChannel and transfers
// one end to parent.  Parent receives a stub with originWorkerId=A.
// Bidirectional via the stub works.
//
// Routing trace:
//   parent.stub.postMessage('a')
//     → envelope routed to A via __edgePostMessageToWorker(A, bytes)
//     → A's dispatcher: entry-path (A owns the port)
//     → entry.deliver via A.port1.original.postMessage
//     → C++ queues on A.port2 → A.port2.on('message') fires
//   A.port2.postMessage('b')
//     → rewired sibling sends envelope to parent
//     → parent's dispatcher: stub-path (parent holds the stub)
//     → stub.emit('message', 'b')
//
// NOTE: child bootstrap installs port-transfer helpers INLINE — the
// worker-threads-per-thread policy patches don't propagate to spawned
// children (policy-propagation is a separate followup).  The inline
// code mirrors WORKER_THREADS_POST_PATCH's port-transfer infra exactly.

// Trigger the worker-threads-per-thread policy patches by requiring
// the patched modules — POST_PATCH on internal/worker and
// WORKER_THREADS_POST_PATCH on worker_threads install the
// __edgePortStubsByGlobalId / __edgeMakePortStub / etc. globals when
// the modules are loaded.  Without this require, the policy installs
// nothing on the parent and the decodePort hook explodes.
require('worker_threads');

function ok(label, cond) { console.log(label + ':' + (cond ? 'PASS' : 'FAIL')); }

if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') {
  console.log('FAIL: __edgeSpawnNodeWorker not installed');
  process.exit(1);
}
if (typeof globalThis.__edgeMakePortStub !== 'function') {
  console.log('FAIL: __edgeMakePortStub not installed (policy active?)');
  process.exit(1);
}

let stubFromChild = null;
let stubReceivedFromChild = null;
let childExitCode = null;

globalThis.__edgeDispatchUserWorkerExit = (_wid, code) => { childExitCode = code; };

const childBootstrap = `
  var keepalive = setInterval(function() {}, 100);

  // === Install port-transfer infra (mirrors policy WORKER_THREADS_POST_PATCH) ===
  if (!globalThis.__edgePortSiblingMap) globalThis.__edgePortSiblingMap = new WeakMap();
  globalThis.__edgePortsByGlobalId = globalThis.__edgePortsByGlobalId || new Map();
  globalThis.__edgePortStubsByGlobalId = globalThis.__edgePortStubsByGlobalId || new Map();
  if (typeof globalThis.__edgePortIdNext !== 'number') globalThis.__edgePortIdNext = 1;

  function neuter(p) {
    if (p.__edgeNeutered) return;
    try { Object.defineProperty(p, '__edgeNeutered', { value: true }); } catch (e) {}
    var t = function() { throw new Error('MessagePort: transferred away'); };
    try { p.postMessage = t; } catch (e) {}
    try { p.start = function() {}; } catch (e) {}
    try { p.ref = function() { return p; }; } catch (e) {}
    try { p.unref = function() { return p; }; } catch (e) {}
    try { p.hasRef = function() { return false; }; } catch (e) {}
    try { p.close = function() {}; } catch (e) {}
  }
  function rewireSibling(sibling, transferredPortId) {
    if (sibling.__edgeSiblingRewired) return;
    try { Object.defineProperty(sibling, '__edgeSiblingRewired', { value: true }); } catch (e) {}
    sibling.postMessage = function(payload) {
      var env = { __edgePortMsg: true, targetPortId: transferredPortId, payload: payload };
      var b = globalThis.__edgePackPostMessage(env);
      globalThis.__edgePostMessageFromWorker(b);
    };
  }
  function allocPortIdChild(port) {
    var id = globalThis.__edgePortIdNext++;
    var orig = port.postMessage.bind(port);
    globalThis.__edgePortsByGlobalId.set(id, { port: port, deliver: orig });
    neuter(port);
    var sib = globalThis.__edgePortSiblingMap.get(port);
    if (sib) rewireSibling(sib, id);
    return id;
  }
  // Wrap MessageChannel for sibling tracking
  var wt = require('worker_threads');
  var origMC = wt.MessageChannel;
  if (!origMC.__edgeWrapped) {
    var sibMap = globalThis.__edgePortSiblingMap;
    var EdgeMC = function() {
      var ch = new origMC();
      sibMap.set(ch.port1, ch.port2);
      sibMap.set(ch.port2, ch.port1);
      return ch;
    };
    EdgeMC.prototype = origMC.prototype;
    Object.defineProperty(EdgeMC, '__edgeWrapped', { value: true });
    wt.MessageChannel = EdgeMC;
  }
  // Inbound dispatcher with envelope routing
  globalThis.__edgeDispatchMessageToChild = function(bytes) {
    var data = globalThis.__edgeUnpackPostMessage(bytes);
    if (data && data.__edgePortMsg === true) {
      var entry = globalThis.__edgePortsByGlobalId.get(data.targetPortId);
      if (entry && typeof entry.deliver === 'function') {
        try { entry.deliver(data.payload); } catch (e) {}
        return;
      }
      var stub = globalThis.__edgePortStubsByGlobalId.get(data.targetPortId);
      if (stub && typeof stub.emit === 'function') stub.emit('message', data.payload);
    }
  };
  // === end inline infra ===

  setTimeout(function() {
    var ch = new wt.MessageChannel();
    var portB = ch.port2;
    portB.on('message', function(m) {
      portB.postMessage('child-replies:' + m);
    });
    var portId = allocPortIdChild(ch.port1);
    var assignId = function(o) { return o === ch.port1 ? portId : null; };
    var value = { kind: 'init', myPort: ch.port1 };
    var bytes = globalThis.__edgePackPostMessage(value, [ch.port1], assignId);
    globalThis.__edgePostMessageFromWorker(bytes);
  }, 300);
  setTimeout(function() {
    clearInterval(keepalive);
    process.exit(0);
  }, 4000);
`;

const workerId = globalThis.__edgeSpawnNodeWorker(childBootstrap);

globalThis.__edgeDispatchMessageFromChild = (wid, bytes) => {
  void wid;
  const data = globalThis.__edgeUnpackPostMessage(bytes, (portId) => {
    const existing = globalThis.__edgePortStubsByGlobalId.get(portId);
    if (existing) return existing;
    return globalThis.__edgeMakePortStub(portId, workerId);
  });
  if (data && data.__edgePortMsg === true) {
    const entry = globalThis.__edgePortsByGlobalId.get(data.targetPortId);
    if (entry && typeof entry.deliver === 'function') {
      try { entry.deliver(data.payload); } catch (e) { void e; }
      return;
    }
    const stub = globalThis.__edgePortStubsByGlobalId.get(data.targetPortId);
    if (stub && typeof stub.emit === 'function') stub.emit('message', data.payload);
    return;
  }
  if (data && data.kind === 'init' && data.myPort) {
    stubFromChild = data.myPort;
    stubFromChild.on('message', (m) => { stubReceivedFromChild = m; });
    setTimeout(() => {
      stubFromChild.postMessage('parent-via-stub');
    }, 100);
  }
};

const startMs = Date.now();
const poll = () => {
  if (stubReceivedFromChild !== null && childExitCode !== null) {
    ok('stub_received', stubFromChild !== null);
    ok('stub_has_origin', stubFromChild && stubFromChild.__edgeOriginWorkerId === workerId);
    ok('child_reply_via_stub', stubReceivedFromChild === 'child-replies:parent-via-stub');
    ok('child_exit_0', childExitCode === 0);
    process.exit(0);
  } else if (Date.now() - startMs > 8000) {
    console.log('TIMEOUT stub=' + (stubFromChild != null) + ' recv=' + JSON.stringify(stubReceivedFromChild) + ' exit=' + childExitCode);
    process.exit(2);
  } else {
    setTimeout(poll, 100);
  }
};
setTimeout(poll, 1500);
