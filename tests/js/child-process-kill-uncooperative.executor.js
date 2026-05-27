// Deliberately ignores opts.signal. Runs a fixed-duration loop, then
// returns naturally. Models a user-installed executor that wasn't
// written to be AbortSignal-aware.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, _opts) {
  if (cmd === 'ignore-kill') {
    // Run for ~150ms, no signal polling.
    await new Promise((r) => setTimeout(r, 150));
    return { stdout: 'completed-despite-kill\n', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};
