// Smoke test for the child-process-via-executor policy.
//
// With the policy enabled, spawnSync goes through our JS intercept
// instead of C++ uv_spawn (which would hit SuspendError under JSPI).
// Default executor echoes "<command> <args>" to stdout.
const { spawnSync } = require('child_process');
const r = spawnSync('echo', ['hello', 'world']);
console.log('status:', r.status);
console.log('stdout:', r.stdout.toString().trimEnd());
console.log('stderr.length:', r.stderr.length);
