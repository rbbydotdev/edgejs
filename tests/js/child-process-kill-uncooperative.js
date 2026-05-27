// Counterpart to child-process-kill-cooperative. The executor here
// IGNORES opts.signal -- the realistic case for many user-installed
// executors that aren't AbortSignal-aware. We verify:
//   - child.kill() returns true (the wasm-side mark goes through)
//   - child.killed = true after the call
//   - exit FIRES with signal=SIGTERM (host's outer wrap notices
//     ac.signal.aborted and reports it, overriding the executor's
//     natural return). So 'exit' semantics ARE consistent regardless
//     of executor cooperation.
//
// The actual semantic boundary: only HOST CPU is leaked when an
// executor ignores opts.signal; from the wasm-side POV, the kill is
// indistinguishable from a cooperative kill.
//
// Documents the P3.8 contract.
const { spawn } = require('child_process');

const child = spawn('ignore-kill', []);

const killReturned = child.kill ? null : 'no-kill-method';
// Kill immediately; the executor's tight loop won't see it.
setTimeout(() => {
  const r = child.kill('SIGTERM');
  console.log('kill returned:', r);
  console.log('killed flag:', child.killed);
}, 30);

child.on('exit', (code, sig) => {
  console.log('exit code:', code, 'signal:', sig);
  console.log('killed flag at exit:', child.killed);
  console.log('kill-return-precheck:', killReturned);
  process.exit(0);
});
