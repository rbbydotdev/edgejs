// Host-worker executor for child-process-spawn-streaming. Pushes 3
// chunks with 100ms delays via opts.onStdout (P3.1 streaming protocol)
// so the test can observe data events arriving incrementally rather
// than all at once after exit.
globalThis.__edgeChildProcessExecutor = async function (cmd, args, opts) {
  if (cmd === 'stream-test') {
    opts.onStdout('chunk1\n');
    await new Promise((r) => setTimeout(r, 100));
    opts.onStdout('chunk2\n');
    await new Promise((r) => setTimeout(r, 100));
    opts.onStdout('chunk3\n');
    return { code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};
