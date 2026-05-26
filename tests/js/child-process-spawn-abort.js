// Verifies options.signal (AbortSignal) handling for spawnSync.
//
// Pre-check at call-entry: if the signal is already aborted,
// spawnSync returns immediately with status=null, signal=killSignal,
// error.code='ABORT_ERR'. Mid-call abort isn't supported (Node's own
// spawnSync also ignores it -- the sync call holds the JS event loop
// so abort() can't fire until after the call returns).
const { spawnSync } = require('child_process');

// 1. No signal -- normal pass-through.
{
  const r = spawnSync('echo', ['no-signal']);
  console.log('plain status:', r.status, 'err:', r.error && r.error.code);
}

// 2. Signal not aborted -- pass-through.
{
  const ac = new AbortController();
  const r = spawnSync('echo', ['unaborted'], { signal: ac.signal });
  console.log('unaborted status:', r.status, 'err:', r.error && r.error.code);
}

// 3. Signal pre-aborted -- immediate ABORT_ERR.
{
  const ac = new AbortController();
  ac.abort();
  const r = spawnSync('echo', ['pre-aborted'], { signal: ac.signal });
  console.log('aborted status:', r.status, 'sig:', r.signal, 'err.code:', r.error && r.error.code);
}

// 4. Pre-aborted with custom killSignal honored.
{
  const ac = new AbortController();
  ac.abort();
  const r = spawnSync('echo', ['x'], { signal: ac.signal, killSignal: 'SIGKILL' });
  console.log('abort-kill status:', r.status, 'sig:', r.signal);
}
