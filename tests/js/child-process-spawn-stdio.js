// Verifies stdio: 'inherit' and 'ignore' modes.
//
// Default fake-shell 'echo' is sync (wasm-worker path); stdio modes
// are applied after the executor returns regardless of which executor
// ran.
const { spawnSync } = require('child_process');

// 1. Default ('pipe'): output captured in result.stdout.
{
  const r = spawnSync('echo', ['pipe-captured']);
  console.log('pipe stdout:', JSON.stringify(r.stdout.toString().trim()), 'len:', r.stdout.length);
}

// 2. 'inherit' for stdout: bytes go to process.stdout (visible inline),
//    result.stdout is empty.
{
  process.stdout.write('marker-before-inherit\n');
  const r = spawnSync('echo', ['inherit-output'], { stdio: ['pipe', 'inherit', 'pipe'] });
  console.log('inherit result-stdout len:', r.stdout.length);
}

// 3. 'ignore' for stdout: dropped entirely.
{
  const r = spawnSync('echo', ['ignored'], { stdio: ['pipe', 'ignore', 'pipe'] });
  console.log('ignore result-stdout len:', r.stdout.length);
}

// 4. 'inherit' for stderr: bytes go to process.stderr.
{
  // false returns code 1 with no output -- swap for something that prints to stderr.
  // Our fake shell doesn't have a 'fail-loud' command; use a simulated one
  // via an executor wouldn't apply here. So just check that 'pipe' default
  // is honored alongside the 'inherit' option for stderr.
  const r = spawnSync('echo', ['stderr-inherit-noop'], { stdio: ['pipe', 'pipe', 'inherit'] });
  console.log('mixed stdout:', JSON.stringify(r.stdout.toString().trim()), 'stderr.len:', r.stderr.length);
}
