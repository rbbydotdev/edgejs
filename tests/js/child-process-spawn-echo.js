// Smoke for the child-process-via-executor policy + its default fake shell.
//
// Default executor handles a small set of UNIX-y commands authentically:
// echo, true, false, cat, env, pwd. Anything else returns ENOENT
// (command not found, exit 127) like a real shell.
const { spawnSync } = require('child_process');

// 1. echo -- args joined by space + newline
{
  const r = spawnSync('echo', ['hello', 'world']);
  console.log('echo status:', r.status, 'out:', JSON.stringify(r.stdout.toString()));
}

// 2. echo -n -- no trailing newline
{
  const r = spawnSync('echo', ['-n', 'no-newline']);
  console.log('echo -n out:', JSON.stringify(r.stdout.toString()));
}

// 3. true / false -- exit codes
{
  console.log('true status:', spawnSync('true', []).status);
  console.log('false status:', spawnSync('false', []).status);
}

// 4. cat -- stdin -> stdout
{
  const r = spawnSync('cat', [], { input: 'piped through cat\n' });
  console.log('cat out:', JSON.stringify(r.stdout.toString()));
}

// 5. unknown command -- ENOENT, exit 127, helpful stderr
{
  const r = spawnSync('nope-not-a-real-cmd', []);
  console.log('unknown status:', r.status, 'err:', JSON.stringify(r.stderr.toString().trim()));
}

// 6. basename resolution -- /bin/echo same as echo
{
  const r = spawnSync('/bin/echo', ['from-path']);
  console.log('/bin/echo out:', JSON.stringify(r.stdout.toString()));
}
