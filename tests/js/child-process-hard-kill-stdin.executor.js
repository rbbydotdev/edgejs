// Reads opts.stdin (AsyncIterable<Uint8Array>) chunk-by-chunk on the
// hard-kill runner. Echoes "GOT:" + joined chunks. Proves the host
// forwards OP_SPAWN_STDIO_WRITE/END (fd 0) into the runner worker.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'stdin-echo-killable') {
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
