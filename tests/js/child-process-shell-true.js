// Proves spawn(..., {shell:true}) actually invokes the shell -- not
// just sets spawnfile. Pre-fix, child-process-spawn-features tested
// only the spawnfile/spawnargs WIRE format but didn't verify the
// shell command actually ran (fake shell didn't know 'sh').
//
// This test installs an executor that handles '/bin/sh -c <cmd>' by
// running a tiny built-in shell-command parser (just enough for
// "echo X | wc -c" style pipelines and 'echo X' variants).
const { spawn } = require('child_process');

const c = spawn('echo hello-from-shell && echo and-another', [], { shell: true });
let out = '';
c.stdout.on('data', (chunk) => { out += chunk.toString(); });
c.on('exit', (code) => {
  console.log('exit:', code);
  console.log('out:', JSON.stringify(out.trim()));
  // The shell should have run BOTH echo commands joined by &&.
  // (Our mini-shell handles && as sequential commands.)
  process.exit(0);
});
