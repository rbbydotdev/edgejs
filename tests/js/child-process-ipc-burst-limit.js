// Verifies the host-rpc-sync-reverse-drain fix: bursts of cp.send that
// exceed the 256-slot reverse-RPC ring still arrive in full because
// SyncRpcClient.callSync now drains queued reverse requests in its
// wait loop (RpcServer.drainOnce). Pre-fix, ~256+slop arrived and the
// rest were silently dropped after reverseClient.call exhausted its
// 100-attempt backoff.
const { spawn } = require('child_process');

const child = spawn('ipc-burst-limit', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

const N = 1000;
let received = 0;
child.on('message', (msg) => {
  received++;
  if (msg && msg.last) {
    console.log('N:', N);
    console.log('all-received?', received === N);
    process.exit(0);
  }
});

for (let i = 0; i < N; i++) child.send({ n: i, last: i === N - 1 });
