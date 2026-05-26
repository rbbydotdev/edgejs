// Smoke for the child-process-via-executor ASYNC path.
//
// Wasm-worker has no local executor installed, so spawnSync routes
// via host RPC -> main thread -> async executor (installed via
// ?mainExecutor=... URL param, see harness-args).
//
// The main-thread executor is intentionally async (returns Promise)
// to exercise the await-in-main + SAB-bridge to the wasm thread.
const { spawnSync } = require('child_process');

// 1. async executor returns greeting
{
  const r = spawnSync('mock-async-greet', ['Alice']);
  console.log('greet status:', r.status, 'out:', JSON.stringify(r.stdout.toString()));
}

// 2. async executor returns non-zero exit + stderr
{
  const r = spawnSync('mock-fail', []);
  console.log('fail status:', r.status, 'err:', JSON.stringify(r.stderr.toString()));
}

// 3. fall-through for unknown commands -> main returns null -> default fake shell
{
  const r = spawnSync('echo', ['fallback-to-default']);
  console.log('default-echo out:', JSON.stringify(r.stdout.toString()));
}
