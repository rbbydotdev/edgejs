// Verifies that a worker_threads child can also do advanced-mode IPC.
// Pre-fix (P0.2), only the primary wasm runtime got the structured-clone
// MessageChannel port; user-spawned worker_threads silently fell back to
// the byte-stream path, losing Map/Set/Date type fidelity with no warning.
//
// Spawns a worker that does cp.spawn(..., {serialization:'advanced'}),
// sends a Map, verifies instanceof Map survives on receipt, then reports
// the result back to the parent via globalThis.__edgeDispatchUserWorkerExit.

if (typeof globalThis.__edgeSpawnNodeWorker !== 'function') {
  console.error('FAIL: __edgeSpawnNodeWorker not installed');
  process.exit(1);
}

let receivedExitCode = null;
globalThis.__edgeDispatchUserWorkerExit = (_id, code) => { receivedExitCode = code; };

const childScript = `
  const { spawn } = require('child_process');
  const c = spawn('clone-echo', [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
  });
  c.on('message', (msg) => {
    if (msg && msg.bye) process.exit(0);
    // Exit code 0 means Map roundtrip preserved type, 7 means it didn't.
    process.exit(msg && msg.echo instanceof Map && msg.echo.get('k') === 'v' ? 0 : 7);
  });
  c.send({ echo: new Map([['k', 'v']]) });
  setTimeout(() => process.exit(9), 5000); // safety timeout
`;

globalThis.__edgeSpawnNodeWorker(childScript);

const startMs = Date.now();
const poll = () => {
  if (receivedExitCode !== null) {
    console.log('child exit:', receivedExitCode);
    console.log('advanced IPC works in worker_threads child:', receivedExitCode === 0);
    process.exit(0);
  } else if (Date.now() - startMs > 8000) {
    console.error('FAIL: no exit within 8s');
    process.exit(2);
  } else {
    setTimeout(poll, 50);
  }
};
setTimeout(poll, 50);
