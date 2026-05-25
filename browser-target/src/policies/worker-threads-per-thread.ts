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
  if (typeof globalThis.__edgeDispatchUserWorkerExit !== 'function') {
    var exitMap = new Map();
    var disp = function(workerId, code) {
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
    var srcPath = urlToSrcPath(url);
    if (typeof srcPath !== 'string' || srcPath.length === 0) {
      return new origWorkerImpl(url, _env, _execArgv, _resourceLimits, _trackUnmanagedFds, _isInternal, _name);
    }
    var bootstrapScript = 'process.argv[1] = ' + JSON.stringify(srcPath) +
                          '; require(' + JSON.stringify(srcPath) + ');';
    var workerId;
    try {
      workerId = globalThis.__edgeSpawnNodeWorker(bootstrapScript, undefined);
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
  EdgeWorkerImpl.prototype.stopThread = function() {};

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
;(function postEdgeWorkerThreadsPatch() {
  // Defensive — these globals come from the wasm runtime's worker.ts
  // (installPostMessageGlobals); if the policy is enabled but the
  // wasm-side hasn't wired the globals (shouldn't happen, but…), bail.
  if (typeof globalThis.__edgePackPostMessage !== 'function') return;
  if (typeof globalThis.__edgeUnpackPostMessage !== 'function') return;
  if (typeof globalThis.__edgePostMessageToWorker !== 'function') return;
  if (typeof Worker !== 'function' || typeof kHandle === 'undefined') return;

  // Worker instance registry keyed by workerId.  Used by the
  // child→parent dispatcher (__edgeDispatchMessageFromChild) to find
  // the right Worker on which to emit('message').
  var workerById = new Map();
  globalThis.__edgeDispatchMessageFromChild = function(workerId, bytes) {
    var w = workerById.get(workerId);
    if (!w) return;
    var data;
    try { data = globalThis.__edgeUnpackPostMessage(bytes); }
    catch (e) {
      // Best-effort: emit 'messageerror' so user code can react to a
      // failed unmarshal.  Phase 1 doesn't surface messageerror via the
      // existing kPublicPort chain, but emitting on Worker directly
      // matches Node's documented behavior closely enough.
      w.emit('messageerror', e);
      return;
    }
    w.emit('message', data);
  };

  // Replace Worker.prototype.postMessage.  Lib's version (line 442 of
  // lib/internal/worker.js) routes through this[kPublicPort] which is
  // a real MessageChannel port we don't actually wire across the
  // wasm boundary.  Our replacement marshals + sends via the host RPC.
  // Transfer lists are accepted but currently ignored (phase 4).
  var origPostMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(value, transferList) {
    var h = this[kHandle];
    if (h && typeof h.__edgeWorkerId === 'number') {
      var bytes = globalThis.__edgePackPostMessage(value);
      globalThis.__edgePostMessageToWorker(h.__edgeWorkerId, bytes);
      // Phase 4: structured-clone transferList support.  For now silently
      // drop — the test suite doesn't exercise transfer (E16 marshal
      // covers by-value typed arrays and ArrayBuffers, which copy).
      void transferList;
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
      super(filename, options);
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
${KEEPALIVE_HELPER_JS}
;(function postEdgeWorkerThreadsParentPortPatch() {
  if (globalThis.__edgeIsUserWorker !== true) return;
  if (typeof globalThis.__edgePostMessageFromWorker !== 'function') return;
  if (typeof globalThis.__edgePackPostMessage !== 'function') return;
  if (typeof globalThis.__edgeUnpackPostMessage !== 'function') return;

  var EventEmitter;
  try { EventEmitter = require('events'); }
  catch (e) { return; }

  // Construct a port-like EventEmitter.  postMessage / start / unref /
  // ref / close mirror Node's MessagePort surface that user code uses.
  // We don't extend MessagePort because the real Node class has
  // hidden internals (kPort, etc.) that aren't reachable here, and
  // user code rarely instanceof-checks parentPort.
  var parentPort = new EventEmitter();
  parentPort.postMessage = function(value, transferList) {
    var bytes = globalThis.__edgePackPostMessage(value);
    globalThis.__edgePostMessageFromWorker(bytes);
    void transferList;
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
  globalThis.__edgeDispatchMessageToChild = function(bytes) {
    var data;
    try { data = globalThis.__edgeUnpackPostMessage(bytes); }
    catch (e) {
      parentPort.emit('messageerror', e);
      return;
    }
    parentPort.emit('message', data);
  };

  module.exports.parentPort = parentPort;
  // workerData: deferred to phase 2.x.  See the policy header comment.
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
