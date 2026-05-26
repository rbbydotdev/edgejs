// A cooperative executor: polls opts.signal periodically, throws when
// aborted so host returns an error result. The wasm side then sees
// 'exit' with signal=killSignal (since signal.aborted is true on host).
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'long-running') {
    // Pretend to do work for up to 5 seconds, checking opts.signal often.
    for (let i = 0; i < 500; i++) {
      if (opts.signal && opts.signal.aborted) {
        // Cooperative shutdown: throw so the host wraps as error.
        // (Alternatively, return early with a partial result.)
        const err = new Error('Aborted');
        err.code = 'ABORT_ERR';
        throw err;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return { stdout: 'completed naturally\n', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};
