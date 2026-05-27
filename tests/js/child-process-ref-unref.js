// Verifies child.ref() / child.unref() lifecycle and that pipe-level
// ref/unref doesn't leak keepalive refcount.
//
// Pre-P1.5 fix: pipe._refed was true at construction without a matching
// keepaliveAcquire(). User calling pipe.unref().ref() (or close while
// _refed=true) imbalanced the counter, pinning the loop forever (or
// releasing too early). After fix, the per-pipe keepalive is opt-in
// and strictly balanced.
const { spawn } = require('child_process');

const c = spawn('echo', ['hello-refs']);

console.log('child.ref is fn:', typeof c.ref === 'function');
console.log('child.unref is fn:', typeof c.unref === 'function');

// Toggle pipe ref/unref a few times to exercise the balance:
if (c.stdout) {
  c.stdout.unref();
  c.stdout.ref();
  c.stdout.unref();
  c.stdout.ref();
}

// Toggle child ref/unref too
c.unref();
c.ref();
c.unref();
c.ref();

let out = '';
c.stdout && c.stdout.on('data', (chunk) => { out += chunk.toString(); });
c.on('exit', (code) => {
  console.log('exit:', code);
  console.log('out:', JSON.stringify(out.trim()));
  process.exit(0);
});
