// Documents the host-rpc-sync-reverse-drain limit (NOTES.md):
// while the wasm worker is blocked in Atomics.wait for a sync RPC reply,
// it cannot drain the reverse-RPC ring. With 256 slots, a tight cp.send
// loop of 1000 messages overflows -- ~256+something arrive (early ring
// fill + backoff-recovery slop), the rest are silently dropped after
// reverseClient.call exhausts its 100-attempt backoff.
//
// Asserts:
//   - At least RING_CAPACITY (256) messages do arrive (proves the ring
//     fills correctly + backoff makes some progress)
//   - Fewer than N arrive (proves the limit IS real, not just imaginary)
//
// A future fix (drainReverseRequests in SyncRpcClient) would let all
// N arrive eventually; that day this test should fail-by-assertion
// because received === N, and we'd flip the upper bound to a pass.
const { spawn } = require('child_process');

const child = spawn('ipc-burst-limit', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

const N = 1000;
const RING_CAPACITY = 256;
let received = 0;
child.on('message', (msg) => {
  received++;
  if (msg && msg.last) {
    console.log('N:', N);
    console.log('at-least-ring-capacity?', received >= RING_CAPACITY);
    console.log('less-than-N?', received < N, '(documents the deferred-drain limit)');
    process.exit(0);
  }
});

for (let i = 0; i < N; i++) child.send({ n: i, last: i === N - 1 });
