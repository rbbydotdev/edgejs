// Verifies that high-volume IPC sends do NOT lose messages and that
// the round-trip works under load. Burst size capped at 200, well
// within our 256-slot reverse-RPC ring capacity.
//
// Bursts beyond ~256 hit a known limit (#!~debt host-rpc-sync-reverse-drain):
// during the wasm tight-send loop, the wasm worker is blocked in
// Atomics.wait for each sync RPC reply and CANNOT drain reverse RPC.
// Host's reverseClient.call retries with exponential backoff for 100
// attempts (~6s); if the wasm worker hasn't freed slots by then, the
// call drops the event silently. Bumping the ring to 256 slots absorbs
// realistic bursts; truly unbounded bursts need the SyncRpcClient to
// drain reverse RPC during its wait (deeper plumbing).
const { spawn } = require('child_process');

const child = spawn('ipc-burst', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

const N = 200;
let received = 0;
child.on('message', (msg) => {
  received++;
  if (msg && msg.last) {
    console.log('received:', received, 'expected:', N);
    console.log('all in order:', msg.lastN === N - 1);
    process.exit(0);
  }
});

for (let i = 0; i < N; i++) {
  child.send({ n: i, last: i === N - 1 });
}
