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
// The keepalive is a `setInterval` because libuv sees it as a pending
// `uv_timer_t` handle — that's what keeps `_start`'s event loop from
// returning while parentPort/Worker has registered 'message' listeners.
//
// CRITICAL: the period must be SHORT (we use 50ms), not long.  Two
// roles:
//   1. Pending-handle behavior: the timer's existence keeps libuv
//      from exiting (any period works for this).
//   2. Loop-driving behavior: libuv's check phase (where setImmediate
//      callbacks queued by reverse-RPC handlers fire) only runs when
//      the loop iterates.  Without a short period, libuv parks in
//      `poll_oneoff` waiting for the next timer — so inbound messages
//      enqueue a setImmediate that never fires.  50ms keeps delivery
//      latency bounded.
//
// #!~debt worker-threads-uses-js-keepalive-not-tsfn — this is the
// pure-JS emulation of emnapi v2 TSFN's `_emnapi_runtime_keepalive_push`.
// Real Path A via TSFN (or a `uv_async_t`-backed C++ binding) would
// wake `poll_oneoff` precisely when needed and would show up under
// `process._getActiveHandles()`.  Deferred until the emnapi v1→v2
// cutover lands (see `vendored-emnapi-flag` debt in NOTES.md).
const KEEPALIVE_PERIOD_MS = 50;
const KEEPALIVE_HELPER_JS = `
function makeKeepalive(periodMs) {
  var handle = null;
  return {
    ensure: function() {
      if (handle === null) {
        // Do NOT call .unref() — we WANT it to keep libuv alive AND
        // drive loop iterations so reverse-RPC's setImmediate fires.
        handle = setInterval(function() {}, periodMs);
      }
    },
    release: function() {
      if (handle !== null) { clearInterval(handle); handle = null; }
    },
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
  var workerKeepalives = new Map();  // wid → keepalive object
  function workerKeepaliveFor(wid) {
    var k = workerKeepalives.get(wid);
    if (k === undefined) {
      k = makeKeepalive(${KEEPALIVE_PERIOD_MS});
      workerKeepalives.set(wid, k);
    }
    return k;
  }
  function dropWorkerKeepalive(wid) {
    var k = workerKeepalives.get(wid);
    if (k !== undefined) { k.release(); workerKeepalives.delete(wid); }
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
  var keepalive = makeKeepalive(${KEEPALIVE_PERIOD_MS});

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
