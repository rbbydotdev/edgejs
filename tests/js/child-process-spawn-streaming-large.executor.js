// Pushes a single 20-KB stdout buffer with a deterministic byte pattern
// so the test can verify byte-for-byte integrity. The chunker on host
// has to split this across multiple ring slots; if the slot budget is
// honored, every byte arrives at wasm-side intact.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'big-stdout') {
    const N = 20 * 1024;
    const buf = new Uint8Array(N);
    for (let i = 0; i < N; i++) buf[i] = i % 251;
    opts.onStdout(buf);
    return { code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};
