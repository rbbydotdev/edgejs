// Verifies maxBuffer enforcement.
//
// Default executor (fake shell) is sync -- maxBuffer check happens
// after the executor returns, in the binding patch's shapeResult.
const { spawnSync } = require('child_process');

// 1. Output under maxBuffer -- pass through normally.
{
  const r = spawnSync('echo', ['short']);
  console.log('under status:', r.status, 'err:', r.error && r.error.code, 'out.len:', r.stdout.length);
}

// 2. Output exceeds maxBuffer -- truncate + ENOBUFS error.
//    "echo " + 200 chars = ~206 bytes, but we cap at 10.
{
  const big = 'x'.repeat(200);
  const r = spawnSync('echo', [big], { maxBuffer: 10 });
  console.log('over status:', r.status, 'sig:', r.signal, 'err.code:', r.error && r.error.code, 'out.len:', r.stdout.length);
}

// 3. Default maxBuffer (1 MB) -- normal call passes.
{
  const r = spawnSync('echo', ['hi']);
  console.log('default status:', r.status, 'err:', r.error && r.error.code);
}
