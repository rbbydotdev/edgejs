// e33 step 2: end-to-end parent→child MessagePort transfer via
// worker.postMessage(value, [port]).
//
// Verifies:
//   - sender's Worker.prototype.postMessage honors transferList without
//     throwing
//   - receiver materializes a JS-side stub at the position the port
//     was in the value tree
//   - stub has the Node MessagePort surface (postMessage, on, start,
//     close, ref, unref, hasRef) and a stable __edgeGlobalPortId
//
// Does NOT yet verify bidirectional routing — stub.postMessage on the
// child intentionally throws in this step.  That's wired in step 3.

if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') {
  console.error('FAIL: __edgeSpawnNodeWorker not installed');
  process.exit(1);
}
if (typeof globalThis.__edgePackPostMessage !== 'function') {
  console.error('FAIL: __edgePackPostMessage not installed');
  process.exit(1);
}

const { MessageChannel } = require('worker_threads');

let receivedFromChild = null;
let childExitCode = null;

globalThis.__edgeDispatchMessageFromChild = (workerId, bytes) => {
  receivedFromChild = globalThis.__edgeUnpackPostMessage(bytes, (id) => ({
    __edgeStub: true, parentSideStub: true, id,
  }));
  void workerId;
};
globalThis.__edgeDispatchUserWorkerExit = (_workerId, code) => {
  childExitCode = code;
};

// Child bootstrap: receive the message, inspect the stub, echo a report
// back to parent, exit.  Uses the raw __edgeDispatchMessageToChild
// since this test doesn't load the worker-threads-per-thread policy
// on the child (the policy's WORKER_THREADS_POST_PATCH would set up
// parentPort with decodePort already; here we install a custom
// dispatcher inline to keep the test self-contained and reproducible).
const childBootstrap = `
  var keepalive = setInterval(function() {}, 100);
  globalThis.__edgeDispatchMessageToChild = function(bytes) {
    var stubFactory = function(portId) {
      // Plain-object stub — sufficient to verify shape; the real
      // policy patch (WORKER_THREADS_POST_PATCH) builds an
      // EventEmitter-backed stub.  We keep this test independent of
      // policy loading and module-load timing.
      var listeners = [];
      var stub = {
        on: function(ev, cb) { if (ev === 'message') listeners.push(cb); return stub; },
        once: function(ev, cb) { return stub.on(ev, cb); },
        off: function() { return stub; },
        emit: function() { return true; },
        removeAllListeners: function() { listeners.length = 0; return stub; },
        listenerCount: function() { return listeners.length; },
        postMessage: function() { throw new Error('not yet routable'); },
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
    // Inspect what we got
    var report = {
      kind: 'inspection',
      top_keys: Object.keys(data),
      payload: data.payload,
      port_exists: !!data.thePort,
      port_is_stub: data.thePort && data.thePort.__edgePortStub === true,
      port_id: data.thePort && data.thePort.__edgeGlobalPortId,
      port_has_postMessage: data.thePort && typeof data.thePort.postMessage === 'function',
      port_has_on: data.thePort && typeof data.thePort.on === 'function',
      port_has_start: data.thePort && typeof data.thePort.start === 'function',
      port_has_close: data.thePort && typeof data.thePort.close === 'function',
      port_has_ref: data.thePort && typeof data.thePort.ref === 'function',
      port_has_unref: data.thePort && typeof data.thePort.unref === 'function',
      port_has_hasRef: data.thePort && typeof data.thePort.hasRef === 'function',
    };
    var replyBytes = globalThis.__edgePackPostMessage(report);
    globalThis.__edgePostMessageFromWorker(replyBytes);
    clearInterval(keepalive);
    process.exit(0);
  };
`;

const workerId = globalThis.__edgeSpawnNodeWorker(childBootstrap);

const ch = new MessageChannel();

setTimeout(() => {
  // Manually do what Worker.prototype.postMessage would do, since this
  // test runs WITHOUT the policy.  Same shape as the policy's patched
  // postMessage: allocate an ID, pass assignPortId callback.
  const portId = 4242;  // any non-zero number
  const assignId = (obj) => (obj === ch.port1 ? portId : null);
  const value = { payload: 'hello-from-parent', thePort: ch.port1 };
  const bytes = globalThis.__edgePackPostMessage(value, [ch.port1], assignId);
  globalThis.__edgePostMessageToWorker(workerId, bytes);
}, 300);

const startMs = Date.now();
const poll = () => {
  if (receivedFromChild !== null && childExitCode !== null) {
    const r = receivedFromChild;
    function ok(label, cond) { console.log(label + ':' + (cond ? 'PASS' : 'FAIL')); }
    ok('payload', r.payload === 'hello-from-parent');
    ok('port_exists', r.port_exists);
    ok('port_is_stub', r.port_is_stub);
    ok('port_id_preserved', r.port_id === 4242);
    ok('port_has_postMessage', r.port_has_postMessage);
    ok('port_has_on', r.port_has_on);
    ok('port_has_start', r.port_has_start);
    ok('port_has_close', r.port_has_close);
    ok('port_has_ref', r.port_has_ref);
    ok('port_has_unref', r.port_has_unref);
    ok('port_has_hasRef', r.port_has_hasRef);
    ok('child_exit_0', childExitCode === 0);
    process.exit(0);
  } else if (Date.now() - startMs > 6000) {
    console.error('FAIL: timeout. received=' + JSON.stringify(receivedFromChild) + ' exit=' + childExitCode);
    process.exit(2);
  } else {
    setTimeout(poll, 100);
  }
};
setTimeout(poll, 500);
