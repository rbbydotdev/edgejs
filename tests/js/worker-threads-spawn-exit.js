// Worker_threads phase 1 — direct probe of the spawn + exit pipeline.
//
// Bypasses the `worker-threads-per-thread` policy and `new Worker()`
// API to test the underlying machinery end-to-end:
//   parent wasm → globalThis.__edgeSpawnNodeWorker(bootstrap)
//   → host RPC OP_SPAWN_USER_WORKER
//   → main spawns (host+wasm) pair, returns workerId
//   → child wasm runs the bootstrap script (process.exit(42))
//   → child wasm posts user-worker-exit to main
//   → main forwards to parent host
//   → parent host reverse-RPCs OP_DELIVER_USER_WORKER_EXIT into parent wasm
//   → parent wasm invokes globalThis.__edgeDispatchUserWorkerExit
//   → this test's dispatcher logs "exit: 42" and exits 0
//
// Phase 2 will add a sibling test that uses `new Worker()` via the
// policy patch — once eval-mode (or a workable file path) is wired.

if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') {
  console.error('FAIL: __edgeSpawnNodeWorker not installed');
  process.exit(1);
}

// Capture the child's exit code via the reverse-RPC dispatcher.  A
// polled setTimeout exits the parent on the natural libuv loop stack
// (process.exit inside the reverse-RPC handler doesn't propagate
// cleanly — handler's try/catch swallows ExitSignal).
let receivedExitCode = null;
globalThis.__edgeDispatchUserWorkerExit = (_workerId, code) => {
  receivedExitCode = code;
};

const id = globalThis.__edgeSpawnNodeWorker('process.exit(42);');
console.log('spawned worker id:', id);

const startMs = Date.now();
const poll = () => {
  if (receivedExitCode !== null) {
    console.log('exit:', receivedExitCode);
    process.exit(0);
  } else if (Date.now() - startMs > 8000) {
    console.error('FAIL: no exit event within 8s');
    process.exit(2);
  } else {
    setTimeout(poll, 50);
  }
};
setTimeout(poll, 50);
