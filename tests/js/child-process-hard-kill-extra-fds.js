// Verifies the hard-kill path routes fd >= 3 pipes through the runner
// worker. Stdio layout: [stdin, stdout, stderr, pipe(fd=3), pipe(fd=4)].
// Test writes to child.stdio[3]; executor reads it from opts.stdio[3],
// transforms it, and writes back through opts.stdio[4]; test listens on
// child.stdio[4] and asserts the round-trip.
const { spawn } = require('child_process');

const child = spawn('fd-roundtrip', [], {
  stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  killable: 'hard',
});

let fd4Buf = '';
child.stdio[4].on('data', (chunk) => { fd4Buf += chunk.toString(); });

child.on('exit', (code) => {
  console.log('fd4 received:', JSON.stringify(fd4Buf));
  console.log('exit:', code);
  process.exit(0);
});

child.stdio[3].write('alpha');
setTimeout(() => {
  child.stdio[3].write('beta');
  setTimeout(() => {
    child.stdio[3].end('gamma');
  }, 30);
}, 30);
