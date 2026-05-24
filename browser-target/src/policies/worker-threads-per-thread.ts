import type { Policy } from "./index";

// Worker_threads phase 1: route `new Worker(filename)` through the
// browser-target's host+wasm pair spawn machinery (one pair per Node
// `Worker`, per docs/worker-threads-design.md).
//
// PHASE 1 DELIVERABLE (per docs/worker-threads-design.md):
//   `new Worker(filename)` spawns pair; child runs file; `exit` event
//   fires on the parent Worker instance.
//
// NOT IN PHASE 1:
//   - `parentPort.postMessage` / `worker.postMessage` (phase 2)
//   - `worker.terminate()` (phase 3)
//   - `worker.on('error', ...)` for uncaught child exceptions (phase 3)
//   - `MessageChannel` + transferables (phase 4)
//   - `workerData` is plumbed end-to-end but used by user code in the
//     child via the standard Node API — phase 2 work covers actually
//     exposing it on the child's `parentPort`.
//
// HOW THIS REACHES THE HOST (Path B chosen; see design doc for rationale)
//
//   user code: new Worker('child.js')
//     ↓
//   lib/internal/worker.js: `new WorkerImpl(url, env, execArgv, ...)`
//     ↓ (this patch replaces WorkerImpl with EdgeWorkerImpl)
//   EdgeWorkerImpl: globalThis.__edgeSpawnNodeWorker(srcPath)
//     ↓ (sync RPC: parks wasm thread on Atomics.wait)
//   host worker: OP_SPAWN_USER_WORKER handler
//     ↓ (postMessage to main)
//   main page: spawnUserWorker — spawnHostWorker + new wasm runtime
//     ↓ (replies with assigned workerId)
//   wasm side: returns synchronously to user; child boots concurrently
//
// HOW EXIT FIRES BACK
//
//   child wasm: ExitSignal → postMessage main `user-worker-exit`
//     ↓
//   main: handleUserWorkerExit → postMessage parent host `deliver-user-worker-exit`
//     ↓
//   parent host: reverseRpcClient.call(OP_DELIVER_USER_WORKER_EXIT, ...)
//     ↓
//   parent wasm: reverseRpcServer handler → globalThis.__edgeDispatchUserWorkerExit
//     ↓
//   THIS PATCH: dispatcher finds the onexit callback registered by
//     lib's `this[kHandle].onexit = ...` assignment, invokes with code
//     ↓
//   lib: `worker.emit('exit', code)` per usual flow
//
// COMPOSITION
//
// Currently OPT-IN — not in `defaultBrowserPolicies`.  Phase 1 is the
// "ship the topology" stage; we promote to default once phase 2+ has
// proven the postMessage path works.  Users opt in via `?policies=worker-threads-per-thread`.

// Pre-patch: replace `internalBinding('worker').Worker` BEFORE the
// module's top-level `const { Worker: WorkerImpl } = internalBinding('worker')`
// destructure reads it.  This is the cleanest interception point — the
// rest of the Worker class constructor + event-emitter wiring (lines
// 197-363 of lib/internal/worker.js) Just Works against a compatible
// shim handle.
//
// Why a `pre` patch (not `post`): the destructure on line 78 captures
// `WorkerImpl` into a module-local const at load time.  A `post` patch
// would have to wholesale replace `module.exports.Worker` AND
// re-implement all the event-emitter wiring (~200 LOC of constructor +
// kOnExit + kOnMessage logic).  Patching the binding before it's read
// is ~30 LOC and leaves the lib's logic intact.
const PRE_PATCH = `
;(function preEdgeWorkerThreadsPatch() {
  // Only patch if both sides are wired: the spawn global (set up by
  // worker.ts installSpawnNodeWorkerGlobal) AND internalBinding is
  // available.  Otherwise fall through to the original (Node-honest
  // ERR_BROWSER_NO_WORKER_THREADS-like behavior — see also the design
  // doc's rejected alternatives).
  if (typeof internalBinding !== 'function') return;
  if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') return;

  var binding;
  try { binding = internalBinding('worker'); } catch (e) { void e; return; }
  if (!binding || typeof binding.Worker !== 'function') return;

  // Ensure the global exit dispatcher exists — wasm calls into this
  // when a child user-worker exits.  Lazy-initialized so multiple
  // policy applications (Worker spawned from within a Worker) compose.
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
  var dispatcher = globalThis.__edgeDispatchUserWorkerExit;

  // Resolve a file path from the URL parameter the lib passes.  For
  // file-mode \`new Worker('/abs/path.js')\`, lib passes a URL object;
  // for eval-mode \`new Worker(code, { eval: true })\` or data-URL mode,
  // lib passes null.  We construct a bootstrap script the child wasm
  // runs verbatim as edge.js's user script.
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

  // Replace the binding's Worker constructor in-place.  Subsequent
  // destructure (line 78 of lib/internal/worker.js) picks up the
  // replacement.  The class shape mirrors what Node's WorkerImpl
  // exposes: \`messagePort\`, \`threadId\`, \`onexit\`, \`startThread()\`,
  // \`invalidExecArgv\`, \`invalidNodeOptions\` — that's the surface
  // lib's Worker class constructor uses (lines 279-355).
  var origWorkerImpl = binding.Worker;
  function EdgeWorkerImpl(url, _env, _execArgv, _resourceLimits, _trackUnmanagedFds, _isInternal, _name) {
    var srcPath = urlToSrcPath(url);
    if (typeof srcPath !== 'string' || srcPath.length === 0) {
      // Phase 1 supports only file-mode \`new Worker(filename)\`.
      // Eval-mode (\`new Worker(code, { eval: true })\`) needs us to
      // intercept the LOAD_SCRIPT messagePort.postMessage to get the
      // code — deferred to a follow-up.  data-URL mode is also
      // deferred.  Fall back to the original WorkerImpl (which on
      // browser-target throws an unsupported-binding error — clear
      // failure mode).
      return new origWorkerImpl(url, _env, _execArgv, _resourceLimits, _trackUnmanagedFds, _isInternal, _name);
    }
    // Spawn the (host+wasm) pair synchronously via the wasm-side global.
    // Workerdata phase-1 is plumbed end-to-end but not encoded here —
    // a future phase will marshal the parent's options.workerData via
    // cross-context-marshal.ts.  Bootstrap script: load srcPath as a
    // Node module after edge.js boots.  process.argv[1] is patched so
    // user code reading __filename gets the right path.
    var bootstrapScript = 'process.argv[1] = ' + JSON.stringify(srcPath) +
                          '; require(' + JSON.stringify(srcPath) + ');';
    var workerId;
    try {
      workerId = globalThis.__edgeSpawnNodeWorker(bootstrapScript, undefined);
    } catch (e) {
      // Surface as ERR_OPERATION_FAILED-flavored — lib code at line 287
      // checks invalidExecArgv/invalidNodeOptions but doesn't catch
      // here, so we re-throw with a clear message.
      throw new Error('Worker spawn failed: ' + ((e && e.message) || e));
    }

    this.threadId = workerId;
    this.invalidExecArgv = undefined;
    this.invalidNodeOptions = undefined;

    // Stub messagePort — phase 1 doesn't support parentPort.postMessage.
    // The lib constructor wires this at line 296 (\`this[kPort] =
    // this[kHandle].messagePort\`) and immediately does \`.on('message')\`
    // + \`.start()\` + \`.unref()\` + sets [kWaitingStreams]=0 (lines
    // 297-300), then later \`postMessage\` (line 335).  All no-ops here.
    var stubPort = {
      on: function() {},
      start: function() {},
      unref: function() {},
      postMessage: function() {},
      ref: function() {},
    };
    this.messagePort = stubPort;

    // Hook onexit setter so we can register the callback into the
    // global dispatcher.  Lib at line 293 does:
    //   this[kHandle].onexit = (code, customErr, customErrReason) => {
    //     this[kOnExit](code, customErr, customErrReason);
    //   };
    // — that callback drives the .emit('exit', code) flow at line 380.
    var pendingOnexit = null;
    var capturedWorkerId = workerId;
    Object.defineProperty(this, 'onexit', {
      get: function() { return pendingOnexit; },
      set: function(fn) {
        pendingOnexit = fn;
        if (typeof fn === 'function') {
          dispatcher._map.set(capturedWorkerId, function(code) {
            // Lib's onexit signature is (code, customErr, customErrReason).
            // Phase 1 only delivers a clean exit code; error propagation
            // (customErr) is phase 3.
            fn(code, null, null);
          });
        } else {
          dispatcher._map.delete(capturedWorkerId);
        }
      },
      configurable: true,
      enumerable: true,
    });
  }

  // No-op startThread — child wasm runtime starts automatically when
  // main receives the spawn request (the pre-queued bootstrap message
  // is the trigger; see E25 sync-spawn-jspi finding).  Lib calls this
  // at line 355 of worker.js right after stdio wiring; we don't need
  // any deferred work here.
  EdgeWorkerImpl.prototype.startThread = function() {};
  // No-op stop — phase 3 will wire this to a 'terminate' message.
  EdgeWorkerImpl.prototype.stopThread = function() {};
  // Phase 1: no loopStart / loopStartTime / takeHeapSnapshot / etc.
  // Lib's performance.eventLoopUtilization at line 351-353 binds these
  // via FunctionPrototypeBind; not in phase 1 scope.  If called, will
  // throw — that's a deferred-feature gap, not a regression.

  binding.Worker = EdgeWorkerImpl;
})();
`;

export const workerThreadsPerThread: Policy = {
  name: "worker-threads-per-thread",
  description:
    "Worker_threads phase 1: route `new Worker(filename)` through host+wasm pair spawn. Each user Worker gets its own (host+wasm) pair with isolated emnapi context (per docs/worker-threads-design.md). Phase 1 ships spawn + exit-event; parentPort.postMessage / terminate / MessageChannel are phase 2+.",
  builtinOverrides: {
    "internal/worker": { pre: PRE_PATCH },
  },
};
