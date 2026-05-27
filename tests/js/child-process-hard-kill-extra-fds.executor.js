// Reads chunks from opts.stdio[3], uppercases them, writes them to
// opts.stdio[4]. Resolves when the input pipe ends so the runner can
// exit naturally. Proves fd >= 3 read AND write directions on the
// hard-kill path.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'fd-roundtrip') {
    const decoder = new TextDecoder();
    const out = opts.stdio[4];
    for await (const chunk of opts.stdio[3]) {
      out.write(decoder.decode(chunk).toUpperCase());
    }
    out.end();
    return { code: 0 };
  }
  return { code: 0 };
};
