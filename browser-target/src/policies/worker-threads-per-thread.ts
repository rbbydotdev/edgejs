import type { Policy } from "./index";

// Worker_threads phase 1+2: route `new Worker(filename)` through the
// browser-target's host+wasm pair spawn machinery (one pair per Node
// `Worker`, per docs/worker-threads-design.md).
//
// PHASE 1 SHIPPED (commit 3cd379c2): spawn + exit-event.
// PHASE 2 SHIPS HERE: bidirectional postMessage between parent and
//   child via the same wasm→host→main→host→wasm RPC chain.  Adds
//   parentPort / parentPort.postMessage / parentPort.on('message') on
//   the child side; adds worker.postMessage / worker.on('message') on
//   the parent side.
//
// NOT IN PHASE 2:
//   - `worker.terminate()` (phase 3)
//   - `worker.on('error', ...)` for uncaught child exceptions (phase 3)
//   - `MessageChannel` + transferables (phase 4)
//   - `workerData` exposure on the child side — `__edgeSpawnNodeWorker`
//     plumbs raw bytes end-to-end (phase 1) but encoding the user's
//     `options.workerData` JS value happens in lib's `Worker`
//     constructor AFTER our EdgeWorkerImpl returns, which is the
//     wrong scope for marshaling.  Deferred to phase 2.x — needs a
//     post-construction "first message" trick or a side-channel.
//
// HOW THIS REACHES THE HOST (Path B; see design doc for rationale)
//
//   user: new Worker('child.js') → lib/internal/worker.js
//     → pre-patch replaces internalBinding('worker').Worker with EdgeWorkerImpl
//   EdgeWorkerImpl → globalThis.__edgeSpawnNodeWorker(srcPath)
//     → sync RPC → parent host → postMessage main → main spawns pair
//     → returns workerId synchronously
//
//   user: worker.postMessage(data)
//     → post-patch's Worker.prototype.postMessage:
//         globalThis.__edgePackPostMessage(data)
//         globalThis.__edgePostMessageToWorker(workerId, bytes)
//     → sync RPC → parent host → postMessage main {worker-message-to-child}
//     → postMessage child host {deliver-message-to-child}
//     → reverseRPC OP_DELIVER_MESSAGE_TO_CHILD → child wasm
//     → globalThis.__edgeDispatchMessageToChild(bytes)
//     → child-side worker_threads post-patch:
//         parentPort.emit('message', __edgeUnpackPostMessage(bytes))
//
//   user (child): parentPort.postMessage(data)
//     → child-side post-patch's parentPort.postMessage:
//         globalThis.__edgePostMessageFromWorker(packed bytes)
//     → sync RPC → child host → postMessage main {worker-message-to-parent}
//     → postMessage parent host {deliver-message-from-child}
//     → reverseRPC OP_DELIVER_MESSAGE_FROM_CHILD → parent wasm
//     → globalThis.__edgeDispatchMessageFromChild(workerId, bytes)
//     → parent-side post-patch's dispatcher:
//         workerById.get(workerId).emit('message', unmarshaled)
//
// HOW EXIT FIRES BACK (phase 1, unchanged)
//
//   child wasm ExitSignal → main → parent host → reverseRPC into parent
//   wasm → __edgeDispatchUserWorkerExit → onexit setter → lib's kOnExit
//   → worker.emit('exit', code).
//
// COMPOSITION
//
// Currently OPT-IN — not in `defaultBrowserPolicies`.  Phase 1 was
// "ship the topology"; phase 2 is "ship the message channel".  Promote
// to default once phase 3 (terminate + error events) is in.  Users opt
// in via `?policies=worker-threads-per-thread`.

// Spoof-proof control envelope (e34+): wire-format helpers shared
// between parent and child sides.  The worker.ts layer prefixes every
// payload byte stream with a "kind" byte (KIND_USER_DATA=0x00 or a
// control kind != 0x00).  User data NEVER touches the kind byte —
// worker.ts owns it end-to-end — so user payloads can no longer
// trigger __edgeWorkerTerminate / __edgeWorkerError / __edgePortMsg
// behavior via property-name spoofing.
//
// Control-payload formats (bytes that follow the kind tag):
//
//   KIND_PORT_MSG (0x01):
//     [u32 LE: targetPortId]
//     [bytes: marshaled payload via packPostMessage]
//   KIND_TERMINATE (0x02):
//     (empty)
//   KIND_WORKER_ERROR (0x03):
//     [bytes: marshaled {name, message, stack} via packPostMessage]
//
// Senders use __edgePostControlToWorker / __edgePostControlFromWorker
// installed in worker.ts.  Receivers register __edgeDispatchControlToChild
// / __edgeDispatchControlFromChild here (in the policy) and parse the
// control payload according to the kind byte.
const CONTROL_HELPERS_JS = `
function __edgeMakePortMsgPayload(targetPortId, payloadBytes) {
  var out = new Uint8Array(4 + payloadBytes.byteLength);
  var dv = new DataView(out.buffer);
  dv.setUint32(0, targetPortId, true);
  out.set(payloadBytes, 4);
  return out;
}
function __edgeParsePortMsgPayload(controlBytes) {
  if (controlBytes.byteLength < 4) return null;
  var dv = new DataView(controlBytes.buffer, controlBytes.byteOffset, controlBytes.byteLength);
  var targetPortId = dv.getUint32(0, true);
  // subarray view — caller may pass straight to unpackPostMessage.
  var payloadBytes = controlBytes.subarray(4);
  return { targetPortId: targetPortId, payloadBytes: payloadBytes };
}
`;

// Libuv-keepalive helper shared by both the parent-side per-Worker
// keepalive and the child-side parentPort keepalive.
//
// REAL PATH A: each keepalive is a `uv_async_t` (allocated via the
// `__edgeNapiHost.uvAsync.acquireSlot(0)` factory installed by
// `napi-host/uv-async.ts`).  `slot.ref()` makes it a pending handle so
// `_start`'s `uv_run` won't return while 'message' listeners are
// registered — that's the same shape Node uses for MessagePort.  When
// the host receives a cross-context message and queues a
// `dispatchOnLibuvTick`-wrapped delivery, worker.ts also calls
// `slot.send()` which fires `uv_async_send` — that wakes a blocked
// `poll_oneoff` immediately, replacing the prior ~50ms `setInterval`
// poll period with O(0) delivery latency.
//
// The slot's wasm-side callback is NULL (cb=0): libuv's own dispatch
// loop at node/deps/uv/src/unix/async.c:205-206 skips wasm dispatch
// when async_cb is NULL, but `uv__async_send` still bumps the loop's
// pending counter and writes the pipe wfd, which is what we need.
// The actual JS dispatch still rides on the reverse-RPC
// `setImmediate`-queued delivery (see `dispatchOnLibuvTick` in
// worker.ts) — `uv_async_send` is just the wake-up signal.  See
// experiments/e23-real-path-a-discovery/FINDINGS.md (Q4) for the
// NULL-cb confirmation.
//
// Resolves #!~debt worker-threads-uses-js-keepalive-not-tsfn (Path A
// shipped 2026-05-25 via real uv_async_t).
const KEEPALIVE_HELPER_JS = `
function makeKeepalive() {
  // Real Path A only: uv_async_t with NULL callback.  ref() makes it
  // a pending handle in libuv's loop; uv_async_send wakes poll_oneoff.
  var handle = null;
  function uvAsync() {
    var h = (typeof globalThis !== 'undefined') ? globalThis.__edgeNapiHost : null;
    return (h && h.uvAsync) ? h.uvAsync : null;
  }
  return {
    ensure: function() {
      if (handle !== null) return;
      var rt = uvAsync();
      if (!rt || typeof rt.acquireSlot !== 'function') {
        throw new Error('worker-threads keepalive: __edgeNapiHost.uvAsync unavailable');
      }
      handle = rt.acquireSlot(0);
      handle.ref();
    },
    release: function() {
      if (handle === null) return;
      try { handle.unref(); } catch (e) { void e; }
      try { handle.close(); } catch (e) { void e; }
      handle = null;
    },
    // Expose the slot so the reverse-RPC dispatcher in worker.ts can
    // call .send() to wake poll_oneoff immediately when an inbound
    // cross-context message arrives.
    slot: function() { return handle; },
    ref: function() { if (handle !== null) { try { handle.ref(); } catch (e) { void e; } } },
    unref: function() { if (handle !== null) { try { handle.unref(); } catch (e) { void e; } } },
  };
}
`;

// Pre-patch on `internal/worker`: replaces `internalBinding('worker').Worker`
// BEFORE the module's top-level `const { Worker: WorkerImpl } = ...` reads
// it.  This is unchanged from phase 1 except:
//   1. EdgeWorkerImpl stores `this.__edgeWorkerId` (used by the post-patch
//      dispatcher to look up Workers).
//   2. The `messagePort` stub stays no-op — lib's user-facing `Worker.
//      prototype.postMessage` (line 442 of lib/internal/worker.js) is
//      replaced in the post-patch below, so messagePort never sees user
//      traffic in phase 2.
const PRE_PATCH = `
;(function preEdgeWorkerThreadsPatch() {
  if (typeof internalBinding !== 'function') return;
  if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') return;

  var binding;
  try { binding = internalBinding('worker'); } catch (e) { void e; return; }
  if (!binding || typeof binding.Worker !== 'function') return;

  // Phase 1 exit-dispatcher (carried forward).
  // Phase 3c (e33+): dispatcher now accepts an optional errorBytes
  // third arg.  When present, an unpacked Error object is emitted on
  // the Worker as 'error' BEFORE the 'exit' callback fires — matches
  // Node's documented event order.
  if (typeof globalThis.__edgeDispatchUserWorkerExit !== 'function') {
    var exitMap = new Map();
    var disp = function(workerId, code, errorBytes) {
      // Emit 'error' first if errorBytes present (item 3c).  The
      // POST_PATCH's EdgeWorkerInstanceTracker registers each Worker
      // instance in globalThis.__edgeWorkersById; look up there to find
      // the Worker we should fire 'error' on.
      if (errorBytes && errorBytes.byteLength > 0
          && globalThis.__edgeWorkersById
          && typeof globalThis.__edgeUnpackPostMessage === 'function') {
        var w = globalThis.__edgeWorkersById.get(workerId);
        if (w && typeof w.emit === 'function') {
          try {
            var payload = globalThis.__edgeUnpackPostMessage(errorBytes);
            // Reconstruct a real Error from the unpacked {name, message, stack} —
            // user code does instanceof Error checks.
            var err = new Error(payload && payload.message ? payload.message : 'uncaught exception in worker');
            if (payload) {
              if (payload.name) try { err.name = payload.name; } catch (e) { void e; }
              if (payload.stack) try { err.stack = payload.stack; } catch (e) { void e; }
            }
            w.emit('error', err);
          } catch (e) { void e; }
        }
      }
      var cb = exitMap.get(workerId);
      if (cb) {
        exitMap.delete(workerId);
        cb(code);
      }
    };
    disp._map = exitMap;
    globalThis.__edgeDispatchUserWorkerExit = disp;
  }
  var exitDispatcher = globalThis.__edgeDispatchUserWorkerExit;

  function urlToSrcPath(url) {
    if (url == null) return null;
    if (typeof url === 'string') return url;
    if (typeof url.pathname === 'string') {
      var p = url.pathname;
      try { p = decodeURIComponent(p); } catch (e) { void e; }
      return p;
    }
    return null;
  }

  var origWorkerImpl = binding.Worker;
  function EdgeWorkerImpl(url, _env, _execArgv, _resourceLimits, _trackUnmanagedFds, _isInternal, _name) {
    // Phase 5 (e34+): eval-mode Worker support.  EdgeWorkerInstanceTracker
    // stashes options.eval===true + the user code string here before
    // super() runs.  When set, we synthesize the bootstrap directly from
    // the code rather than treating url as a path to require().
    //
    // Cleared in finally on the tracker side to avoid leaking to nested
    // constructs.  We snapshot locally before any other work.
    var evalCode = (globalThis.__edgePendingEvalCode === true || typeof globalThis.__edgePendingEvalCode === 'string')
      ? globalThis.__edgePendingEvalCode
      : null;
    var bootstrapScript;
    if (typeof evalCode === 'string') {
      // url is the code string itself when options.eval is true.
      bootstrapScript = evalCode;
    } else {
      var srcPath = urlToSrcPath(url);
      if (typeof srcPath !== 'string' || srcPath.length === 0) {
        return new origWorkerImpl(url, _env, _execArgv, _resourceLimits, _trackUnmanagedFds, _isInternal, _name);
      }
      bootstrapScript = 'process.argv[1] = ' + JSON.stringify(srcPath) +
                        '; require(' + JSON.stringify(srcPath) + ');';
    }
    // Phase 3a (e33+): the outer constructor wrapper (EdgeWorkerInstanceTracker
    // below) stashes the user's options.workerData here before super()
    // runs, so we can pass it through the spawn payload to the child.
    // The binding-level args don't include workerData (lib delivers it
    // via the LOAD_SCRIPT messagePort message in Node, which our
    // messagePort stub drops — see Phase 3a notes in policy header).
    var wdBytes = globalThis.__edgePendingWorkerData || undefined;
    var workerId;
    try {
      workerId = globalThis.__edgeSpawnNodeWorker(bootstrapScript, wdBytes);
    } catch (e) {
      throw new Error('Worker spawn failed: ' + ((e && e.message) || e));
    }

    this.threadId = workerId;
    // Phase 2: this field is the routing key the post-patched
    // Worker.prototype.postMessage uses to identify the destination.
    this.__edgeWorkerId = workerId;
    this.invalidExecArgv = undefined;
    this.invalidNodeOptions = undefined;

    // Stub messagePort — phase 1 didn't need it, phase 2 still doesn't
    // (the user-facing postMessage path is intercepted at the Worker
    // class level in the post-patch).  Lib's constructor wires this
    // (line 296 onwards), then posts a LOAD_SCRIPT to it (line 335) —
    // that LOAD_SCRIPT is meaningless on our path because the child
    // wasm already has its bootstrap from the spawn payload.
    var stubPort = {
      on: function() {},
      start: function() {},
      unref: function() {},
      postMessage: function() {},
      ref: function() {},
    };
    this.messagePort = stubPort;

    // Hook onexit setter (carried forward from phase 1).
    var pendingOnexit = null;
    var capturedWorkerId = workerId;
    Object.defineProperty(this, 'onexit', {
      get: function() { return pendingOnexit; },
      set: function(fn) {
        pendingOnexit = fn;
        if (typeof fn === 'function') {
          exitDispatcher._map.set(capturedWorkerId, function(code) {
            fn(code, null, null);
          });
        } else {
          exitDispatcher._map.delete(capturedWorkerId);
        }
      },
      configurable: true,
      enumerable: true,
    });
  }

  EdgeWorkerImpl.prototype.startThread = function() {};
  // Phase 3b (e33+): worker.terminate() flows lib → kHandle.stopThread().
  // e34+ spoof-proof envelope: terminate now uses the dedicated control
  // channel (kind=0x02, empty payload).  User data can NEVER reach byte 0
  // since worker.ts owns it — so worker.postMessage with any user payload
  // cannot trigger termination.  Exit signal still flows through the
  // existing user-worker-exit pipeline → parent's onexit → lib's
  // terminate Promise resolves with code 1.
  EdgeWorkerImpl.prototype.stopThread = function() {
    var wid = this.__edgeWorkerId;
    if (typeof wid !== 'number') return;
    if (typeof globalThis.__edgePostControlToWorker !== 'function') return;
    if (!globalThis.__edgePmKind) return;
    try {
      globalThis.__edgePostControlToWorker(wid, globalThis.__edgePmKind.TERMINATE, new Uint8Array(0));
    } catch (e) { void e; }
  };

  binding.Worker = EdgeWorkerImpl;
})();
`;

// Post-patch on `internal/worker`: now that lib has defined its Worker
// class (which uses `kHandle` and `kPublicPort` Symbols local to this
// module), we can: (1) replace `Worker.prototype.postMessage` to route
// through our handle's workerId instead of through `kPublicPort`
// (which never receives messages on our path); (2) wrap the Worker
// constructor to register every Worker instance in a workerId→Worker
// map for the parent-side dispatcher.
//
// `kHandle` is the Symbol used by lib at line 279 to attach our
// EdgeWorkerImpl to the Worker instance.  Both `kHandle` and `Worker`
// are in scope here because this code runs at the END of
// `internal/worker.js` module evaluation.
const POST_PATCH = `
${KEEPALIVE_HELPER_JS}
${CONTROL_HELPERS_JS}
;(function postEdgeWorkerThreadsPatch() {
  // Defensive — these globals come from the wasm runtime's worker.ts
  // (installPostMessageGlobals); if the policy is enabled but the
  // wasm-side hasn't wired the globals (shouldn't happen, but…), bail.
  if (typeof globalThis.__edgePackPostMessage !== 'function') return;
  if (typeof globalThis.__edgeUnpackPostMessage !== 'function') return;
  if (typeof globalThis.__edgePostMessageToWorker !== 'function') return;
  if (typeof Worker !== 'function' || typeof kHandle === 'undefined') return;

  // EventEmitter for the port stub (e33).  require('events') is
  // a Node built-in always available at policy-patch execution; if it
  // fails the runtime is broken anyway — bail and skip the patch.
  var EventEmitter;
  try { EventEmitter = require('events'); }
  catch (e) { void e; return; }

  // Phase 4 (e33): MessagePort transfer infra shared between parent and
  // child sides.  Detect MessagePort by duck-typing the methods the
  // edge.js binding installs.  Worker has postMessage too but lacks
  // start/ref/unref/hasRef as own methods, so the combined check is
  // specific enough.
  function __edgeIsLikelyMessagePort(v) {
    return v != null && typeof v === 'object'
      && typeof v.postMessage === 'function'
      && typeof v.start === 'function'
      && typeof v.close === 'function'
      && typeof v.ref === 'function'
      && typeof v.unref === 'function'
      && typeof v.hasRef === 'function';
  }
  if (typeof globalThis.__edgePortIdNext !== 'number') {
    globalThis.__edgePortIdNext = 1;
  }
  if (!globalThis.__edgePortsByGlobalId) {
    globalThis.__edgePortsByGlobalId = new Map();
  }
  if (!globalThis.__edgePortStubsByGlobalId) {
    globalThis.__edgePortStubsByGlobalId = new Map();
  }
  // Item 4 (e33): after transfer, the sender's port must become
  // unusable per spec.  We can't fully destroy the C++ port object
  // because our routing uses it as the delivery channel (calling
  // port.postMessage internally queues on the kept sibling), so we
  // capture the original methods BEFORE neutering and stash a
  // delivery function alongside the now-neutered port.
  function __edgeNeuterPort(port) {
    if (port.__edgeNeutered) return;
    try { Object.defineProperty(port, '__edgeNeutered', { value: true }); }
    catch (e) { void e; }
    var neutered = function() {
      throw new Error('MessagePort: this port has been transferred to another worker and is no longer usable');
    };
    try { port.postMessage = neutered; } catch (e) { void e; }
    try { port.start = function() {}; } catch (e) { void e; }
    // ref/unref/hasRef: Node treats neutered ports as if unref'd —
    // they don't keep the loop alive.  Be tolerant.
    try { port.ref = function() { return port; }; } catch (e) { void e; }
    try { port.unref = function() { return port; }; } catch (e) { void e; }
    try { port.hasRef = function() { return false; }; } catch (e) { void e; }
    try { port.close = function() {}; } catch (e) { void e; }
    // Listener APIs (on/once/off/emit) stay intact — they're just
    // never invoked since no messages will arrive after transfer.
  }
  // Item 1 (e33): track MessageChannel sibling pairs so that when one
  // side is transferred, the kept side's postMessage can be rewired to
  // envelope-route to the transferred-away stub.  Populated by the
  // MessageChannel wrap installed in the worker_threads patch.
  if (!globalThis.__edgePortSiblingMap) {
    globalThis.__edgePortSiblingMap = new WeakMap();
  }
  function __edgeRewireSiblingForTransfer(sibling, transferredPortId, destinationWorkerId) {
    if (sibling.__edgeSiblingRewired) return;
    try { Object.defineProperty(sibling, '__edgeSiblingRewired', { value: true }); }
    catch (e) { void e; }
    try { Object.defineProperty(sibling, '__edgeTransferredPortId', { value: transferredPortId }); }
    catch (e) { void e; }
    // Keep onmessage paths intact (the C++ binding still queues
    // INCOMING messages from the now-orphaned local sibling-of-
    // transferred port — but those come from the envelope dispatcher
    // calling entry.deliver, NOT from any user code).  We just rewire
    // postMessage to route via envelope instead of via C++.
    sibling.postMessage = function(payload) {
      // e34+ spoof-proof control envelope: targetPortId + marshaled
      // payload, routed via __edgePostControlToWorker/FromWorker.
      var payloadBytes = globalThis.__edgePackPostMessage(payload);
      var controlBytes = __edgeMakePortMsgPayload(transferredPortId, payloadBytes);
      var k = globalThis.__edgePmKind ? globalThis.__edgePmKind.PORT_MSG : 0x01;
      if (typeof destinationWorkerId === 'number') {
        globalThis.__edgePostControlToWorker(destinationWorkerId, k, controlBytes);
      } else if (typeof globalThis.__edgePostControlFromWorker === 'function') {
        globalThis.__edgePostControlFromWorker(k, controlBytes);
      } else {
        throw new Error('edge.js: sibling-rewired port has no cross-worker transport');
      }
    };
  }
  function __edgeAllocPortId(port, destinationWorkerId) {
    // Items 2-full + 3 (e33): if this is an already-transferred stub
    // being re-transferred (e.g. parent received port from child A, now
    // forwarding to child B), reuse the existing port-ID rather than
    // allocate a fresh one.  The original entry (wherever it was first
    // registered) is the source of truth for routing.  Also record
    // where we sent it so the dispatcher can forward envelopes from
    // the original entry-owner that arrive HERE.
    if (port.__edgePortStub === true && typeof port.__edgeGlobalPortId === 'number') {
      var existingId = port.__edgeGlobalPortId;
      if (!port.__edgeNeutered) __edgeNeuterPort(port);
      if (typeof destinationWorkerId === 'number') {
        try { port.__edgeForwardedTo = destinationWorkerId; } catch (e) { void e; }
      }
      return existingId;
    }
    var id = globalThis.__edgePortIdNext++;
    var origPostMessage = port.postMessage.bind(port);
    globalThis.__edgePortsByGlobalId.set(id, {
      port: port,
      deliver: origPostMessage,
      destinationWorkerId: destinationWorkerId,
    });
    __edgeNeuterPort(port);
    // Item 1: rewire sibling's postMessage so parent→child via the kept
    // port reaches the transferred port's stub on the other side.
    var sibling = globalThis.__edgePortSiblingMap.get(port);
    if (sibling) {
      __edgeRewireSiblingForTransfer(sibling, id, destinationWorkerId);
    }
    return id;
  }
  // Build a stub matching Node MessagePort surface.  Backed by Node's
  // EventEmitter for listener semantics; postMessage envelopes through
  // the cross-worker bus.
  //
  // originWorkerId (item 2 e33): when this stub is materialized on the
  // PARENT side from a message sent by a child worker, originWorkerId
  // is that child's worker ID — so stub.postMessage routes via
  // __edgePostMessageToWorker(originWorkerId, bytes).  On the CHILD
  // side, originWorkerId is undefined and stub.postMessage routes via
  // __edgePostMessageFromWorker (i.e., back to parent).
  function __edgeMakePortStub(globalPortId, originWorkerId) {
    var stub = new EventEmitter();
    stub.postMessage = function(payload) {
      // e34+ spoof-proof control envelope.
      var payloadBytes = globalThis.__edgePackPostMessage(payload);
      var controlBytes = __edgeMakePortMsgPayload(globalPortId, payloadBytes);
      var k = globalThis.__edgePmKind ? globalThis.__edgePmKind.PORT_MSG : 0x01;
      if (typeof originWorkerId === 'number' && typeof globalThis.__edgePostControlToWorker === 'function') {
        // Parent → specific child worker (originator of the port).
        globalThis.__edgePostControlToWorker(originWorkerId, k, controlBytes);
      } else if (typeof globalThis.__edgePostControlFromWorker === 'function') {
        // Child → parent via existing bus.
        globalThis.__edgePostControlFromWorker(k, controlBytes);
      } else if (typeof globalThis.__edgePostControlToWorker === 'function') {
        // Parent-side stub with no recorded origin.
        throw new Error('edge.js: parent-side stub.postMessage without originWorkerId (item 2)');
      } else {
        throw new Error('edge.js: stub.postMessage has no cross-worker transport available');
      }
    };
    stub.start = function() {};
    stub.close = function() {
      var ports = globalThis.__edgePortStubsByGlobalId;
      if (ports) ports.delete(globalPortId);
    };
    stub.ref = function() { return stub; };
    stub.unref = function() { return stub; };
    stub.hasRef = function() { return true; };
    Object.defineProperty(stub, '__edgePortStub', { value: true });
    Object.defineProperty(stub, '__edgeGlobalPortId', { value: globalPortId });
    if (originWorkerId !== undefined) {
      try { Object.defineProperty(stub, '__edgeOriginWorkerId', { value: originWorkerId }); }
      catch (e) { void e; }
    }
    globalThis.__edgePortStubsByGlobalId.set(globalPortId, stub);
    return stub;
  }
  globalThis.__edgeIsLikelyMessagePort = __edgeIsLikelyMessagePort;
  globalThis.__edgeAllocPortId = __edgeAllocPortId;
  globalThis.__edgeMakePortStub = __edgeMakePortStub;

  // Worker instance registry keyed by workerId.  Used by the
  // child→parent dispatcher (__edgeDispatchMessageFromChild) to find
  // the right Worker on which to emit('message').
  // Phase 3c (e33+): also exposed on globalThis.__edgeWorkersById so
  // the exit dispatcher (in PRE_PATCH scope) can emit 'error' events
  // on the right Worker before exit fires.
  var workerById = new Map();
  globalThis.__edgeWorkersById = workerById;
  globalThis.__edgeDispatchMessageFromChild = function(workerId, bytes) {
    var data;
    try {
      // Phase 4 (e33): plumb decodePort so MARSHAL_TAG_PORT_REF in
      // child-to-parent messages materializes a stub on parent side.
      // originWorkerId comes from the WIRE so re-transferred stubs
      // carry the right routing target through arbitrary chains.
      data = globalThis.__edgeUnpackPostMessage(bytes, function(globalPortId, originWid) {
        var existing = globalThis.__edgePortStubsByGlobalId.get(globalPortId);
        if (existing) return existing;
        return globalThis.__edgeMakePortStub(globalPortId, originWid);
      });
    } catch (e) {
      var wErr = workerById.get(workerId);
      if (wErr) wErr.emit('messageerror', e);
      return;
    }
    // User-data path is now spoof-proof — control envelopes (port-msg,
    // terminate, worker-error) ride a separate kind byte at the
    // worker.ts layer and route through __edgeDispatchControlFromChild
    // below.  Anything reaching THIS dispatcher is unambiguously user
    // data and goes straight to Worker.on('message').
    var w = workerById.get(workerId);
    if (!w) return;
    w.emit('message', data);
  };

  // e34+ control dispatcher (parent side).  Called by worker.ts when
  // the inbound payload's kind byte is non-zero.  kind comes from
  // __edgePmKind.PORT_MSG / WORKER_ERROR.  controlBytes is the payload
  // after the kind byte was stripped by worker.ts.
  globalThis.__edgeDispatchControlFromChild = function(workerId, kind, controlBytes) {
    var KK = globalThis.__edgePmKind || { PORT_MSG: 0x01, TERMINATE: 0x02, WORKER_ERROR: 0x03 };
    if (kind === KK.PORT_MSG) {
      var pm = __edgeParsePortMsgPayload(controlBytes);
      if (!pm) return;
      var payload;
      try {
        payload = globalThis.__edgeUnpackPostMessage(pm.payloadBytes, function(globalPortId, originWid) {
          var existing = globalThis.__edgePortStubsByGlobalId.get(globalPortId);
          if (existing) return existing;
          return globalThis.__edgeMakePortStub(globalPortId, originWid);
        });
      } catch (e) {
        return;
      }
      // Triage: (a) entry → we own port; (b) stub forwarded → forward;
      // (c) stub here → emit.
      var entry = globalThis.__edgePortsByGlobalId.get(pm.targetPortId);
      if (entry && typeof entry.deliver === 'function') {
        try { entry.deliver(payload); } catch (e) { void e; }
        return;
      }
      var stub = globalThis.__edgePortStubsByGlobalId.get(pm.targetPortId);
      if (stub && typeof stub.__edgeForwardedTo === 'number') {
        // Forward to next hop via control envelope (re-encode the
        // payload bytes — they may include port refs that the stub
        // factory just materialized, but we're sending bytes as-is
        // since the wire format already encoded them).
        var fwdControl = __edgeMakePortMsgPayload(pm.targetPortId, pm.payloadBytes);
        globalThis.__edgePostControlToWorker(stub.__edgeForwardedTo, KK.PORT_MSG, fwdControl);
        return;
      }
      if (stub && typeof stub.emit === 'function') {
        stub.emit('message', payload);
      }
      return;
    }
    if (kind === KK.WORKER_ERROR) {
      var errInfo;
      try { errInfo = globalThis.__edgeUnpackPostMessage(controlBytes); }
      catch (e) { return; }
      var wErr2 = workerById.get(workerId);
      if (wErr2 && typeof wErr2.emit === 'function') {
        var err3c = new Error((errInfo && errInfo.message) || 'uncaught exception in worker');
        if (errInfo) {
          if (errInfo.name) try { err3c.name = errInfo.name; } catch (e) { void e; }
          if (errInfo.stack) try { err3c.stack = errInfo.stack; } catch (e) { void e; }
        }
        wErr2.emit('error', err3c);
      }
      return;
    }
    // KIND_TERMINATE doesn't make sense parent-side (children get
    // terminated by parents, not vice versa).  Ignore silently.
  };

  // Replace Worker.prototype.postMessage.  Lib's version (line 442 of
  // lib/internal/worker.js) routes through this[kPublicPort] which is
  // a real MessageChannel port we don't actually wire across the
  // wasm boundary.  Our replacement marshals + sends via the host RPC.
  //
  // Phase 4 (e33): honor transferList for MessagePort entries.  Each
  // port gets a globally-unique ID; the marshal layer emits
  // MARSHAL_TAG_PORT_REF for it.  Receiver materializes a stub.
  // Bidirectional stub routing is e33 step 3.
  var origPostMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(value, transferList) {
    var h = this[kHandle];
    if (h && typeof h.__edgeWorkerId === 'number') {
      var assignPortId = null;
      if (transferList && transferList.length > 0) {
        for (var ti = 0; ti < transferList.length; ti++) {
          if (!globalThis.__edgeIsLikelyMessagePort(transferList[ti])) {
            throw new TypeError('worker.postMessage: transferList entry ' + ti + ' is not a transferable (only MessagePort supported in phase 4 MVP)');
          }
        }
        // Items 1-3 (e33): map each transferable port to
        // { id, originWorkerId }.  For fresh ports we own, origin is
        // our hostWorkerId (0 = parent).  For already-transferred
        // stubs being re-transferred, carry forward their existing
        // origin so the receiver routes to the ORIGINAL allocator.
        var idByPort = new Map();
        var childWid = h.__edgeWorkerId;
        var ourOrigin = (typeof globalThis.__edgeHostWorkerId === 'number') ? globalThis.__edgeHostWorkerId : 0;
        for (var pi = 0; pi < transferList.length; pi++) {
          var p = transferList[pi];
          if (!idByPort.has(p)) {
            var newId = globalThis.__edgeAllocPortId(p, childWid);
            var origin = (p.__edgePortStub === true && typeof p.__edgeOriginWorkerId === 'number')
              ? p.__edgeOriginWorkerId
              : ourOrigin;
            idByPort.set(p, { id: newId, originWorkerId: origin });
          }
        }
        assignPortId = function(obj) {
          return idByPort.has(obj) ? idByPort.get(obj) : null;
        };
      }
      var bytes = globalThis.__edgePackPostMessage(value, transferList, assignPortId);
      globalThis.__edgePostMessageToWorker(h.__edgeWorkerId, bytes);
      return;
    }
    return origPostMessage.apply(this, arguments);
  };

  // Per-Worker libuv keepalive on the PARENT side.  See the
  // KEEPALIVE_HELPER_JS comment in this file for rationale.
  //
  // Real Path A: each keepalive owns a UvAsyncSlot whose .send()
  // is callable from the reverse-RPC handler in worker.ts to wake the
  // parent's poll_oneoff the moment an inbound message arrives.  The
  // slot is published on globalThis.__edgeUvAsyncSlots keyed by
  // workerId so worker.ts can do the lookup without an import.
  var workerKeepalives = new Map();  // wid → keepalive object
  if (!globalThis.__edgeUvAsyncSlots) {
    globalThis.__edgeUvAsyncSlots = new Map();
  }
  function workerKeepaliveFor(wid) {
    var k = workerKeepalives.get(wid);
    if (k === undefined) {
      k = makeKeepalive();
      workerKeepalives.set(wid, k);
      // Wrap ensure() so each engagement re-publishes the slot to the
      // worker.ts-visible map.
      var origEnsure = k.ensure;
      k.ensure = function() {
        origEnsure();
        globalThis.__edgeUvAsyncSlots.set(wid, k.slot());
      };
    }
    return k;
  }
  function dropWorkerKeepalive(wid) {
    var k = workerKeepalives.get(wid);
    if (k !== undefined) { k.release(); workerKeepalives.delete(wid); }
    globalThis.__edgeUvAsyncSlots.delete(wid);
  }

  // Wrap the Worker constructor to register instances in workerById.
  // ES6 class subclassing preserves the prototype chain (EventEmitter
  // etc.) so user-facing APIs are unchanged.
  var OrigWorker = module.exports.Worker;
  class EdgeWorkerInstanceTracker extends OrigWorker {
    constructor(filename, options) {
      // Phase 3a (e33+): grab options.workerData BEFORE super() runs.
      // super() triggers lib's Worker constructor → binding.Worker (=
      // our EdgeWorkerImpl) which spawns the child.  EdgeWorkerImpl
      // reads globalThis.__edgePendingWorkerData and passes those
      // bytes to __edgeSpawnNodeWorker.  The bytes land on the child
      // as globalThis.__edgeUserWorkerDataBytes; the child-side
      // WORKER_THREADS_POST_PATCH unmarshals + exposes as
      // require('worker_threads').workerData.
      //
      // Using globalThis as a thread-local since class-field stash
      // can't be used before super().  Cleared in finally to avoid
      // leaking to nested constructs.
      try {
        var __wd = options && options.workerData;
        if (__wd !== undefined) {
          try { globalThis.__edgePendingWorkerData = globalThis.__edgePackPostMessage(__wd); }
          catch (e) { globalThis.__edgePendingWorkerData = null; throw e; }
        } else {
          globalThis.__edgePendingWorkerData = null;
        }
        // Phase 5 (e34+): if eval-mode, stash the code so EdgeWorkerImpl
        // synthesizes the bootstrap directly instead of treating filename
        // as a path.  Node's lib/internal/worker.js validates options.eval
        // before reaching the binding, so trusting it here is safe.
        if (options && options.eval === true && typeof filename === 'string') {
          globalThis.__edgePendingEvalCode = filename;
        } else {
          globalThis.__edgePendingEvalCode = null;
        }
        super(filename, options);
      } finally {
        globalThis.__edgePendingWorkerData = null;
        globalThis.__edgePendingEvalCode = null;
      }
      var h = this[kHandle];
      if (h && typeof h.__edgeWorkerId === 'number') {
        var wid = h.__edgeWorkerId;
        workerById.set(wid, this);
        // Clean up on exit so workerById doesn't leak across spawns,
        // and drop the keepalive so the parent loop can drain.
        this.on('exit', function() {
          workerById.delete(wid);
          dropWorkerKeepalive(wid);
        });
        // Keepalive lifecycle: install on first 'message' listener,
        // tear down when listenerCount drops to 0.
        // 'newListener' fires BEFORE the listener is added — use the
        // EVENT itself as the trigger (count would still read 0).
        this.on('newListener', function(event) {
          if (event === 'message') workerKeepaliveFor(wid).ensure();
        });
        // 'removeListener' fires AFTER removal — the post-removal
        // listenerCount is the right value to gate teardown on.
        this.on('removeListener', function(event) {
          if (event === 'message' && this.listenerCount('message') === 0) {
            dropWorkerKeepalive(wid);
          }
        });
        // Node's worker.unref()/ref() semantics: unref lets the loop
        // exit even while listeners are registered; ref re-attaches.
        var origUnref = this.unref ? this.unref.bind(this) : null;
        var origRef = this.ref ? this.ref.bind(this) : null;
        var self = this;
        this.unref = function() {
          dropWorkerKeepalive(wid);
          return origUnref ? origUnref() : self;
        };
        this.ref = function() {
          if (self.listenerCount('message') > 0) workerKeepaliveFor(wid).ensure();
          return origRef ? origRef() : self;
        };
      }
    }
  }
  module.exports.Worker = EdgeWorkerInstanceTracker;
})();
`;

// Post-patch on `worker_threads`: in user-worker mode (set by worker.ts
// when the bootstrap message arrives), replace the default `parentPort:
// null` export with a real port.
//
// The port is a thin EventEmitter (lib has its own `require('events')`
// available in user code, and `worker_threads.js` is loaded BEFORE user
// code runs).  Its `postMessage` method marshals + calls
// `__edgePostMessageFromWorker`; its 'message' events are fired by the
// dispatcher installed alongside.
//
// In parent mode (`__edgeIsUserWorker` is undefined/false), this patch
// is a no-op — parentPort stays null, matching Node's main-thread
// semantics.
const WORKER_THREADS_POST_PATCH = `
;(function postEdgeWorkerThreadsMessageChannelWrap() {
  // Item 1 (e33): wrap MessageChannel so we can track sibling pairs
  // (port1 ↔ port2 from the same channel) in a WeakMap.  When a port
  // is later transferred, the kept sibling's postMessage gets rewired
  // to envelope-route to the transferred port's stub instead of
  // queuing on the now-orphaned C++ sibling.
  //
  // Runs on BOTH parent and child isolates (no __edgeIsUserWorker
  // gate), since either side may create channels.  Idempotent via the
  // __edgeWrapped marker.
  if (!globalThis.__edgePortSiblingMap) {
    globalThis.__edgePortSiblingMap = new WeakMap();
  }
  try {
    var origMC = module.exports.MessageChannel;
    if (origMC && origMC.__edgeWrapped !== true) {
      var siblingMap = globalThis.__edgePortSiblingMap;
      var EdgeMessageChannel = function EdgeMessageChannel() {
        var ch = new origMC();
        try { siblingMap.set(ch.port1, ch.port2); } catch (e) { void e; }
        try { siblingMap.set(ch.port2, ch.port1); } catch (e) { void e; }
        return ch;
      };
      // Preserve prototype chain so instanceof MessageChannel still works
      // (lib code does some prototype probes).
      EdgeMessageChannel.prototype = origMC.prototype;
      try { Object.defineProperty(EdgeMessageChannel, '__edgeWrapped', { value: true }); }
      catch (e) { void e; }
      module.exports.MessageChannel = EdgeMessageChannel;
    }
  } catch (e) { void e; }
})();

${KEEPALIVE_HELPER_JS}
${CONTROL_HELPERS_JS}
;(function postEdgeWorkerThreadsParentPortPatch() {
  if (globalThis.__edgeIsUserWorker !== true) return;
  if (typeof globalThis.__edgePostMessageFromWorker !== 'function') return;
  if (typeof globalThis.__edgePackPostMessage !== 'function') return;
  if (typeof globalThis.__edgeUnpackPostMessage !== 'function') return;

  var EventEmitter;
  try { EventEmitter = require('events'); }
  catch (e) { return; }

  // Phase 4 (e33): port-transfer helpers (mirror POST_PATCH).
  // Re-installed on the child side since worker isolates have their
  // own globals.  Idempotent — these are no-ops if already installed.
  function __edgeIsLikelyMessagePortChild(v) {
    return v != null && typeof v === 'object'
      && typeof v.postMessage === 'function'
      && typeof v.start === 'function'
      && typeof v.close === 'function'
      && typeof v.ref === 'function'
      && typeof v.unref === 'function'
      && typeof v.hasRef === 'function';
  }
  if (typeof globalThis.__edgePortIdNext !== 'number') {
    globalThis.__edgePortIdNext = 1;
  }
  if (!globalThis.__edgePortsByGlobalId) {
    globalThis.__edgePortsByGlobalId = new Map();
  }
  if (!globalThis.__edgePortStubsByGlobalId) {
    globalThis.__edgePortStubsByGlobalId = new Map();
  }
  function __edgeNeuterPortChild(port) {
    if (port.__edgeNeutered) return;
    try { Object.defineProperty(port, '__edgeNeutered', { value: true }); }
    catch (e) { void e; }
    var neutered = function() {
      throw new Error('MessagePort: this port has been transferred to another worker and is no longer usable');
    };
    try { port.postMessage = neutered; } catch (e) { void e; }
    try { port.start = function() {}; } catch (e) { void e; }
    try { port.ref = function() { return port; }; } catch (e) { void e; }
    try { port.unref = function() { return port; }; } catch (e) { void e; }
    try { port.hasRef = function() { return false; }; } catch (e) { void e; }
    try { port.close = function() {}; } catch (e) { void e; }
  }
  // Item 1 (e33): sibling tracking mirror on child side.
  if (!globalThis.__edgePortSiblingMap) {
    globalThis.__edgePortSiblingMap = new WeakMap();
  }
  function __edgeRewireSiblingForTransferChild(sibling, transferredPortId, destinationWorkerId) {
    if (sibling.__edgeSiblingRewired) return;
    try { Object.defineProperty(sibling, '__edgeSiblingRewired', { value: true }); }
    catch (e) { void e; }
    try { Object.defineProperty(sibling, '__edgeTransferredPortId', { value: transferredPortId }); }
    catch (e) { void e; }
    sibling.postMessage = function(payload) {
      // e34+ spoof-proof control envelope.
      var payloadBytes = globalThis.__edgePackPostMessage(payload);
      var controlBytes = __edgeMakePortMsgPayload(transferredPortId, payloadBytes);
      var k = globalThis.__edgePmKind ? globalThis.__edgePmKind.PORT_MSG : 0x01;
      if (typeof destinationWorkerId === 'number') {
        globalThis.__edgePostControlToWorker(destinationWorkerId, k, controlBytes);
      } else {
        // Child-side: route up to parent
        globalThis.__edgePostControlFromWorker(k, controlBytes);
      }
    };
  }
  function __edgeAllocPortIdChild(port, destinationWorkerId) {
    // Items 2-full + 3 (e33) — child-side stub re-transfer: reuse
    // existing ID, record forward target for dispatcher routing.
    if (port.__edgePortStub === true && typeof port.__edgeGlobalPortId === 'number') {
      var existingId = port.__edgeGlobalPortId;
      if (!port.__edgeNeutered) __edgeNeuterPortChild(port);
      if (typeof destinationWorkerId === 'number') {
        try { port.__edgeForwardedTo = destinationWorkerId; } catch (e) { void e; }
      }
      return existingId;
    }
    var id = globalThis.__edgePortIdNext++;
    var origPostMessage = port.postMessage.bind(port);
    globalThis.__edgePortsByGlobalId.set(id, {
      port: port,
      deliver: origPostMessage,
      destinationWorkerId: destinationWorkerId,
    });
    __edgeNeuterPortChild(port);
    var sibling = globalThis.__edgePortSiblingMap.get(port);
    if (sibling) {
      __edgeRewireSiblingForTransferChild(sibling, id, destinationWorkerId);
    }
    return id;
  }
  // Child-side stub factory.  EventEmitter is already in scope on this
  // patch (lib's require('events') ran at the top of WORKER_THREADS_POST_PATCH
  // for parentPort construction).  Use it directly — same battle-tested
  // EE code path that parentPort uses.
  function __edgeMakePortStubChild(globalPortId, originWorkerId) {
    var stub = new EventEmitter();
    stub.postMessage = function(payload) {
      // e34+ spoof-proof control envelope.
      var payloadBytes = globalThis.__edgePackPostMessage(payload);
      var controlBytes = __edgeMakePortMsgPayload(globalPortId, payloadBytes);
      var k = globalThis.__edgePmKind ? globalThis.__edgePmKind.PORT_MSG : 0x01;
      // Route based on the port's ORIGIN worker.  Cross-child sends
      // directly to origin via toWorker; otherwise route up to parent.
      var ourId = (typeof globalThis.__edgeHostWorkerId === 'number') ? globalThis.__edgeHostWorkerId : -1;
      if (typeof originWorkerId === 'number' && originWorkerId !== 0 && originWorkerId !== ourId
          && typeof globalThis.__edgePostControlToWorker === 'function') {
        globalThis.__edgePostControlToWorker(originWorkerId, k, controlBytes);
      } else if (typeof globalThis.__edgePostControlFromWorker === 'function') {
        globalThis.__edgePostControlFromWorker(k, controlBytes);
      } else {
        throw new Error('edge.js: stub.postMessage has no cross-worker transport available');
      }
    };
    stub.start = function() {};
    stub.close = function() {
      var ports = globalThis.__edgePortStubsByGlobalId;
      if (ports) ports.delete(globalPortId);
    };
    stub.ref = function() { return stub; };
    stub.unref = function() { return stub; };
    stub.hasRef = function() { return true; };
    Object.defineProperty(stub, '__edgePortStub', { value: true });
    Object.defineProperty(stub, '__edgeGlobalPortId', { value: globalPortId });
    if (originWorkerId !== undefined) {
      try { Object.defineProperty(stub, '__edgeOriginWorkerId', { value: originWorkerId }); }
      catch (e) { void e; }
    }
    globalThis.__edgePortStubsByGlobalId.set(globalPortId, stub);
    return stub;
  }
  globalThis.__edgeIsLikelyMessagePort = __edgeIsLikelyMessagePortChild;
  globalThis.__edgeAllocPortId = __edgeAllocPortIdChild;
  globalThis.__edgeMakePortStub = __edgeMakePortStubChild;

  // Construct a port-like EventEmitter.  postMessage / start / unref /
  // ref / close mirror Node's MessagePort surface that user code uses.
  // We don't extend MessagePort because the real Node class has
  // hidden internals (kPort, etc.) that aren't reachable here, and
  // user code rarely instanceof-checks parentPort.
  var parentPort = new EventEmitter();
  parentPort.postMessage = function(value, transferList) {
    // Items 1-3 (e33): mirror parent-side allocation w/ originWorkerId.
    var assignPortId = null;
    if (transferList && transferList.length > 0) {
      for (var ti = 0; ti < transferList.length; ti++) {
        if (!__edgeIsLikelyMessagePortChild(transferList[ti])) {
          throw new TypeError('parentPort.postMessage: transferList entry ' + ti + ' is not a transferable (only MessagePort supported in phase 4 MVP)');
        }
      }
      var idByPort = new Map();
      var ourOrigin = (typeof globalThis.__edgeHostWorkerId === 'number') ? globalThis.__edgeHostWorkerId : 0;
      for (var pi = 0; pi < transferList.length; pi++) {
        var p = transferList[pi];
        if (!idByPort.has(p)) {
          var newId = __edgeAllocPortIdChild(p);
          var origin = (p.__edgePortStub === true && typeof p.__edgeOriginWorkerId === 'number')
            ? p.__edgeOriginWorkerId
            : ourOrigin;
          idByPort.set(p, { id: newId, originWorkerId: origin });
        }
      }
      assignPortId = function(obj) {
        return idByPort.has(obj) ? idByPort.get(obj) : null;
      };
    }
    var bytes = globalThis.__edgePackPostMessage(value, transferList, assignPortId);
    globalThis.__edgePostMessageFromWorker(bytes);
  };

  // Libuv keepalive — see KEEPALIVE_HELPER_JS comment for rationale.
  // Real Path A: the slot from this keepalive is published on
  // globalThis.__edgeParentPortUvAsyncSlot so the OP_DELIVER_MESSAGE_TO_CHILD
  // reverse-RPC handler in worker.ts can call .send() to wake poll_oneoff
  // the moment a parent→child message arrives.
  var keepalive = makeKeepalive();
  var origEnsure = keepalive.ensure;
  var origRelease = keepalive.release;
  keepalive.ensure = function() {
    origEnsure();
    globalThis.__edgeParentPortUvAsyncSlot = keepalive.slot();
  };
  keepalive.release = function() {
    origRelease();
    globalThis.__edgeParentPortUvAsyncSlot = null;
  };

  // 'newListener' fires BEFORE the listener is added, so listenerCount
  // would still read 0 at that point — use the EVENT as the trigger.
  parentPort.on('newListener', function(event) {
    if (event === 'message') keepalive.ensure();
  });
  // 'removeListener' fires AFTER the listener is removed — the count
  // reflects post-removal state.
  parentPort.on('removeListener', function(event) {
    if (event === 'message' && parentPort.listenerCount('message') === 0) {
      keepalive.release();
    }
  });

  // Port lifecycle methods.  unref()/close() let the loop exit;
  // ref() re-attaches if a 'message' listener is still registered.
  var origRemoveAll = parentPort.removeAllListeners.bind(parentPort);
  parentPort.removeAllListeners = function(event) {
    var r = origRemoveAll(event);
    if (!event || event === 'message') keepalive.release();
    return r;
  };
  parentPort.start = function() {};
  parentPort.unref = function() { keepalive.release(); return parentPort; };
  parentPort.ref = function() {
    if (parentPort.listenerCount('message') > 0) keepalive.ensure();
    return parentPort;
  };
  parentPort.close = function() { keepalive.release(); };

  // Wire the dispatcher.  Reverse RPC from parent → child fires this
  // global; we unmarshal and emit on parentPort.
  //
  // Phase 4 (e33): plumb decodePort so MARSHAL_TAG_PORT_REF entries
  // materialize as stubs on the child side.
  // e34+ user-data path is now spoof-proof: control envelopes flow
  // through __edgeDispatchControlToChild below, never through here.
  globalThis.__edgeDispatchMessageToChild = function(bytes) {
    var data;
    try {
      data = globalThis.__edgeUnpackPostMessage(bytes, function(globalPortId, originWid) {
        var existing = globalThis.__edgePortStubsByGlobalId.get(globalPortId);
        if (existing) return existing;
        return __edgeMakePortStubChild(globalPortId, originWid);
      });
    } catch (e) {
      parentPort.emit('messageerror', e);
      return;
    }
    parentPort.emit('message', data);
  };

  // e34+ control dispatcher (child side).  Called by worker.ts when
  // the inbound payload's kind byte is non-zero.
  globalThis.__edgeDispatchControlToChild = function(kind, controlBytes) {
    var KK = globalThis.__edgePmKind || { PORT_MSG: 0x01, TERMINATE: 0x02, WORKER_ERROR: 0x03 };
    if (kind === KK.TERMINATE) {
      // Parent's EdgeWorkerImpl.stopThread fires this; exit(1) matches
      // Node's terminate semantics.  Spoof-proof: user data CAN'T
      // reach this path because the kind byte is set by worker.ts,
      // not by user payloads.
      try { process.exit(1); } catch (e) { void e; }
      return;
    }
    if (kind === KK.PORT_MSG) {
      var pm = __edgeParsePortMsgPayload(controlBytes);
      if (!pm) return;
      var payload;
      try {
        payload = globalThis.__edgeUnpackPostMessage(pm.payloadBytes, function(globalPortId, originWid) {
          var existing = globalThis.__edgePortStubsByGlobalId.get(globalPortId);
          if (existing) return existing;
          return __edgeMakePortStubChild(globalPortId, originWid);
        });
      } catch (e) {
        return;
      }
      var entry = globalThis.__edgePortsByGlobalId.get(pm.targetPortId);
      if (entry && typeof entry.deliver === 'function') {
        try { entry.deliver(payload); } catch (e) { void e; }
        return;
      }
      var stub = globalThis.__edgePortStubsByGlobalId.get(pm.targetPortId);
      if (stub && typeof stub.__edgeForwardedTo === 'number') {
        var fwdControl = __edgeMakePortMsgPayload(pm.targetPortId, pm.payloadBytes);
        if (typeof globalThis.__edgePostControlToWorker === 'function') {
          globalThis.__edgePostControlToWorker(stub.__edgeForwardedTo, KK.PORT_MSG, fwdControl);
        } else if (typeof globalThis.__edgePostControlFromWorker === 'function') {
          globalThis.__edgePostControlFromWorker(KK.PORT_MSG, fwdControl);
        }
        return;
      }
      if (stub && typeof stub.emit === 'function') {
        stub.emit('message', payload);
      }
      return;
    }
    // WORKER_ERROR is child→parent only; ignore if received here.
  };

  module.exports.parentPort = parentPort;
  // Phase 3c (e33+): catch uncaught exceptions / unhandled rejections in
  // the child and forward to parent via the existing exit channel.
  // Without this, edge.js's eval-script (-e flag) catches top-level
  // throws and returns cleanly (exit 0), losing both error context
  // AND the non-zero exit code Node spec requires.
  //
  // Approach: install process.on uncaughtException + unhandledRejection
  // handlers that pack the Error and send a special envelope to parent
  // via __edgePostMessageFromWorker, then process.exit(1).  Parent's
  // __edgeDispatchMessageFromChild already routes envelopes; we add a
  // __edgeWorkerError tag handled symmetrically with __edgeWorkerTerminate.
  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    var sendErrorAndExit = function(err) {
      try {
        // e34+ spoof-proof control envelope: error info goes out as
        // KIND_WORKER_ERROR (kind=0x03) with marshaled {name, message,
        // stack} payload.  Parent's control dispatcher reconstructs an
        // Error and emits it on the Worker.
        var errInfo = {
          name: (err && err.name) || 'Error',
          message: (err && err.message) || String(err),
          stack: (err && err.stack) || '',
        };
        var errBytes = globalThis.__edgePackPostMessage(errInfo);
        var KK = globalThis.__edgePmKind || { WORKER_ERROR: 0x03 };
        globalThis.__edgePostControlFromWorker(KK.WORKER_ERROR, errBytes);
      } catch (e) { void e; }
      try { process.exit(1); } catch (e) { void e; }
    };
    process.on('uncaughtException', sendErrorAndExit);
    process.on('unhandledRejection', sendErrorAndExit);
  }
  // Phase 3a (e33+): expose workerData on require('worker_threads').
  // Bytes were stashed on globalThis.__edgeUserWorkerDataBytes by
  // worker.ts's edge-user-worker-bootstrap handler.  Unmarshal via the
  // same packPostMessage/unpackPostMessage round-trip used for
  // postMessage — handles all structured-cloneable types.  Default is
  // undefined when no workerData was passed (matches Node).
  var __wdBytes = globalThis.__edgeUserWorkerDataBytes;
  if (__wdBytes && __wdBytes.byteLength > 0) {
    try {
      module.exports.workerData = globalThis.__edgeUnpackPostMessage(__wdBytes);
    } catch (e) {
      module.exports.workerData = undefined;
      void e;
    }
  }
})();
`;

export const workerThreadsPerThread: Policy = {
  name: "worker-threads-per-thread",
  description:
    "Worker_threads phase 1+2: route `new Worker(filename)` through host+wasm pair spawn (phase 1: spawn + exit-event) plus bidirectional postMessage (phase 2: worker.postMessage / parentPort + parentPort.postMessage).  Each user Worker gets its own (host+wasm) pair with isolated emnapi context (per docs/worker-threads-design.md).  Terminate / error event / MessageChannel transferables remain phase 3+.",
  builtinOverrides: {
    "internal/worker": { pre: PRE_PATCH, post: POST_PATCH },
    worker_threads: { post: WORKER_THREADS_POST_PATCH },
  },
};
