// Verifies the hard-kill path streams stdout incrementally instead of
// buffering until exit. The executor pushes three chunks with awaits
// between them; the test asserts that 'data' events fire BEFORE the
// 'exit' event in the right count + order.
const { spawn } = require('child_process');

const child = spawn('stream-three', [], { killable: 'hard' });

const chunks = [];
child.stdout.on('data', (chunk) => { chunks.push(chunk.toString()); });

child.on('exit', (code) => {
  console.log('chunk count:', chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    console.log('  chunk', i, JSON.stringify(chunks[i]));
  }
  console.log('joined:', chunks.join(''));
  console.log('exit code:', code);
  process.exit(0);
});
