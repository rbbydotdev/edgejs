// Verifies timeout enforcement on the async executor path.
//
// Executor (installed in host worker via executor64 URL param):
//   - 'fast-greet': resolves in 5ms with "fast\n"
//   - 'slow-hang':  resolves in 5000ms -- timeout should fire first
//
// Node semantics for spawnSync timeout: when exceeded, child is killed
// with options.killSignal (default SIGTERM), result.status=null,
// result.signal=killSignal, result.error has code ETIMEDOUT.
const { spawnSync } = require('child_process');

// 1. fast call finishes before timeout
{
  const r = spawnSync('fast-greet', [], { timeout: 1000 });
  console.log('fast status:', r.status, 'sig:', r.signal, 'out:', JSON.stringify(r.stdout.toString()));
}

// 2. slow call exceeds timeout; killed with SIGTERM
{
  const r = spawnSync('slow-hang', [], { timeout: 50 });
  console.log('timeout status:', r.status, 'sig:', r.signal, 'err.code:', r.error && r.error.code);
}

// 3. custom killSignal honored
{
  const r = spawnSync('slow-hang', [], { timeout: 50, killSignal: 'SIGKILL' });
  console.log('killsig status:', r.status, 'sig:', r.signal);
}
