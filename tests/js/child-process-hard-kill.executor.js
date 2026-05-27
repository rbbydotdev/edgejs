// Deliberately uncooperative: tight CPU-burning loop, never yields
// to the event loop, never polls opts.signal. Without hard kill,
// the executor runs to its (very large) iteration cap; with hard
// kill, the runner Worker gets terminate()d and the loop just
// stops mid-iteration.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, _opts) {
  if (cmd === 'runaway-loop') {
    // Burn CPU for ~10 seconds worth of busy loop. If we ever finish,
    // log to stdout so the test can detect the failure mode.
    let n = 0;
    const target = 1e10; // ~10s on modern hardware; way more than the test waits
    while (n < target) n++;
    return { stdout: 'loop-completed-which-is-bad\n', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};
