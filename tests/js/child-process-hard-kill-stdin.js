// Verifies the hard-kill path pipes child.stdin.write() bytes into
// the executor's opts.stdin AsyncIterable. Same shape as the
// cooperative-path stdin-stream test, just with {killable:'hard'}.
const { spawn } = require('child_process');

const child = spawn('stdin-echo-killable', [], { killable: 'hard' });

let captured = '';
child.stdout.on('data', (chunk) => { captured += chunk.toString(); });
child.on('exit', (code) => {
  console.log(captured.trimEnd());
  console.log('exit code:', code);
  process.exit(0);
});

child.stdin.write('alpha ');
setTimeout(() => {
  child.stdin.write('beta ');
  setTimeout(() => {
    child.stdin.write('gamma');
    child.stdin.end();
  }, 50);
}, 50);
