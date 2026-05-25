// e40+: Real Path A keepalive end-to-end test (no heartbeat).
//
// Spawn a child whose ONLY pending handle is the parentPort message
// listener.  Parent posts at +300ms.  Child must receive (proving the
// keepalive holds AND uv_async_send wakes poll_oneoff) and exit clean.
//
// Pre-e40 fix: child exited at ~140ms because the policy keepalive's
// uv_async_t was registered on uv_default_loop while
// RunEventLoopUntilQuiescent drove env->loop — different loops.  Fixed
// by routing acquireSlot through napi_get_uv_event_loop in uv-async.ts.
// See experiments/e40-cpp-debugger/FINDINGS.md.
const { Worker } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

let messageReceived = null;
let exitCode = null;

const childCode = `
  const wt = require('worker_threads');
  wt.parentPort.on('message', (m) => {
    wt.parentPort.postMessage({ received: m });
    wt.parentPort.removeAllListeners('message');
  });
`;

const w = new Worker(childCode, { eval: true });
w.on('message', (m) => { messageReceived = m; });
w.on('exit', (c) => { exitCode = c; });

setTimeout(() => w.postMessage('via-real-path-a'), 300);

setTimeout(() => {
  ok('child_received_message', messageReceived !== null);
  ok('payload_round_tripped', messageReceived && messageReceived.received === 'via-real-path-a');
  ok('child_exit_clean', exitCode === 0);
  process.exit(0);
}, 2000);
