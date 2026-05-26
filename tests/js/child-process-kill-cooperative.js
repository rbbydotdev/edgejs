// Demonstrates kill() semantics in the browser-target. Real OS signals
// don't exist here (no OS process to deliver them to), so kill() works
// by firing the AbortSignal exposed to the executor via opts.signal.
// Cooperating executors check opts.signal periodically and shut down
// cleanly; non-cooperating ones run to completion (the wasm side still
// observes child.killed = true and the kill() call returns true).
//
// This test installs an executor that DOES cooperate. We spawn it,
// kill it mid-run, and verify the child exited with the killSignal
// in the 'exit' event (not the natural exit code).
const { spawn } = require('child_process');

const child = spawn('long-running', [], { killSignal: 'SIGTERM' });

child.on('exit', (code, sig) => {
  console.log('exit code:', code, 'signal:', sig);
  console.log('killed:', child.killed);
  process.exit(0);
});

// Let the executor start, then kill it
setTimeout(() => {
  console.log('killing...');
  child.kill('SIGTERM');
}, 100);
