// Test file for the e40 C++ debugger investigation.
//
// This test minimally reproduces the keepalive-alone scenario that
// e37 + e38 showed exits at ~144ms despite uv_loop_alive==1.
//
// Spawn a child worker with ONLY a parentPort.on('message', cb)
// keepalive — no other handles.  In the child, register the listener
// and do nothing else.  The child SHOULD stay alive indefinitely
// (until parent posts a message, which never happens — the parent
// holds onto the worker reference but never posts).
//
// Expected (with Real Path A working): child loop blocks forever in
// poll_oneoff.  Without working keepalive: child exits within ~150ms.
//
// Set breakpoints in deps/libuv-wasix/src/unix/core.c uv_run() loop
// and step to see where uv_run decides to return.

const { Worker } = require('worker_threads');

const childCode = `
  const { parentPort } = require('worker_threads');
  console.log('[child] listener registering at t=' + Math.round(performance.now()));
  parentPort.on('message', (m) => {
    console.log('[child] message received: ' + m);
    process.exit(0);
  });
  console.log('[child] listener registered, returning from bootstrap');
`;

const w = new Worker(childCode, { eval: true });
w.on('exit', (code) => {
  console.log('[parent] child exited with code=' + code + ' at t=' + Math.round(performance.now()));
});

// Parent: keep alive for 30 seconds to give us time to debug.
// Do NOT post any message to the child — child should stay alive
// purely because of its message listener keepalive.
console.log('[parent] worker spawned, NOT posting any message — child should stay alive on keepalive alone');
setTimeout(() => {
  console.log('[parent] 30s elapsed, exiting');
  process.exit(0);
}, 30000);
