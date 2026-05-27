// Verifies P4.1 transferable IPC: child.send(msg, undefined, {transferList: [ab]})
// transfers the ArrayBuffer (zero-copy) instead of cloning.
// After the call, sender's reference must be DETACHED (byteLength=0).
//
// The receiver should get the original bytes intact (size + content).
const { spawn } = require('child_process');

const child = spawn('transfer-echo', [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  serialization: 'advanced',
});

child.on('message', (msg) => {
  if (msg && msg.echoed) {
    console.log('echoed-size:', msg.echoed.byteLength);
    console.log('echoed-first-byte:', new Uint8Array(msg.echoed)[0]);
    console.log('echoed-last-byte:', new Uint8Array(msg.echoed)[msg.echoed.byteLength - 1]);
  }
  if (msg && msg.bye) {
    process.exit(0);
  }
});

const SIZE = 8 * 1024; // 8 KB
const ab = new ArrayBuffer(SIZE);
const view = new Uint8Array(ab);
for (let i = 0; i < SIZE; i++) view[i] = i & 0xff;

console.log('pre-send size:', ab.byteLength);
child.send({ payload: ab }, undefined, { transferList: [ab] });
console.log('post-send size:', ab.byteLength); // expect 0 (detached)

child.send({ bye: true });
