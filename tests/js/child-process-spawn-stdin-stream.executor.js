// Host-worker executor for child-process-spawn-stdin-stream. Consumes
// opts.stdin (P3.2 AsyncIterable) chunk-by-chunk, then echoes back
// "GOT:" + joined chunks. Verifies wasm -> sync RPC -> host queue ->
// executor's iterator round-trip works in real time.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'stdin-echo') {
    const decoder = new TextDecoder();
    const lines = [];
    for await (const chunk of opts.stdin) {
      lines.push(decoder.decode(chunk));
    }
    opts.onStdout('GOT:' + lines.join('|') + '\n');
    return { code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};
