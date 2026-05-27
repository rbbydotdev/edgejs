// Pushes three stdout chunks separated by awaits so that they MUST
// arrive as separate 'data' events on the wasm side (proves streaming
// rather than batched-on-exit delivery on the killable path).
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'stream-three') {
    opts.onStdout('one\n');
    await new Promise((r) => setTimeout(r, 30));
    opts.onStdout('two\n');
    await new Promise((r) => setTimeout(r, 30));
    opts.onStdout('three\n');
    return { code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};
