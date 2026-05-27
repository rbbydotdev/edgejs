// Verifies spawn options that don't have a meaningful in-browser
// implementation (detached, uid, gid, windowsHide, windowsVerbatimArguments)
// are silently accepted -- spawn doesn't throw, child runs normally,
// spawnfile/spawnargs reflect what was requested. Matches Node on
// platforms that don't support these options (e.g. setuid on
// unprivileged containers, process groups on Windows for some flags).
//
// This is an explicit ASSERTION of the "we accept these silently"
// policy stated in the policy file header; pre-test it was an
// undocumented implicit behavior.
const { spawn } = require('child_process');

const c = spawn('echo', ['opts-test'], {
  detached: true,
  uid: 1000,
  gid: 1000,
  windowsHide: true,
  windowsVerbatimArguments: false,
});

let out = '';
c.stdout.on('data', (chunk) => { out += chunk.toString(); });
c.on('exit', (code) => {
  console.log('exit:', code);
  console.log('out:', JSON.stringify(out.trim()));
  console.log('spawnfile:', c.spawnfile);
  console.log('spawnargs:', JSON.stringify(c.spawnargs));
  process.exit(0);
});
