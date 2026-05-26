// Verifies async spawn() actually STREAMS stdout chunks as they arrive,
// rather than batching them all after the child exits.
//
// The streaming executor (installed via ?executor64=) pushes 3 chunks
// with 100ms delays between them, then resolves with code=0. The test
// measures the elapsed time between the first 'data' event and 'exit'.
// If chunks streamed: elapsed >= ~200ms (we saw chunks 50/150/250ms in
// and exit at 300ms+). If batched: all 3 data events fire after exit,
// elapsed is near 0.
const { spawn } = require('child_process');

const child = spawn('stream-test', []);
const chunks = [];
let firstDataAt = null;
let exitAt = null;

child.stdout.on('data', (chunk) => {
  if (firstDataAt == null) firstDataAt = Date.now();
  chunks.push({ at: Date.now(), text: chunk.toString() });
});

child.on('exit', (code, sig) => {
  exitAt = Date.now();
  console.log('chunks received:', chunks.length);
  console.log('chunk texts:', chunks.map(c => c.text).join('|'));
  console.log('exit code:', code, 'sig:', sig);
  if (firstDataAt != null && chunks.length >= 2) {
    const firstToLast = chunks[chunks.length - 1].at - chunks[0].at;
    // If chunks streamed, gap between first and last data event > 100ms
    // (executor sleeps 100ms between pushes). If batched (old behavior),
    // gap < 10ms because they all emit back-to-back after exit.
    console.log('streamed?', firstToLast >= 100 ? 'YES' : 'NO (batched)');
    // Also verify first data arrived BEFORE exit -- batched mode would
    // emit data after exit fires.
    console.log('data-before-exit?', firstDataAt < exitAt ? 'YES' : 'NO');
  }
  process.exit(0);
});
