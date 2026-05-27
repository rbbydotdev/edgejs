// Verifies P4.3 hard kill: executor runs in a dedicated Worker; kill()
// calls Worker.terminate() and halts the executor's JS even when it's
// ignoring opts.signal (e.g. tight loop). Compare to cooperative-kill
// where the executor MUST cooperate to actually stop.
//
// The executor here is deliberately uncooperative: it enters a sync
// loop that never yields, never polls opts.signal. Without hard kill,
// this would burn host-worker CPU forever; with hard kill, terminate()
// halts it within milliseconds and 'exit' fires with SIGTERM.
const { spawn } = require('child_process');

const start = Date.now();
const child = spawn('runaway-loop', [], { killable: 'hard' });

setTimeout(() => {
  console.log('killing...');
  child.kill('SIGTERM');
}, 100);

child.on('exit', (code, sig) => {
  const elapsed = Date.now() - start;
  console.log('exit code:', code, 'signal:', sig);
  console.log('killed:', child.killed);
  // The runaway loop logs to stdout if it ever escapes -- we should NOT
  // see "loop-completed" in any output because terminate halts it.
  console.log('elapsed-reasonable?', elapsed < 1000); // hard kill should be near-immediate
  process.exit(0);
});
