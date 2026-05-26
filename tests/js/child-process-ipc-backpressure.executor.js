// Counts messages and echoes back. Verifies the channel handles
// burst sends without losing any.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'ipc-burst') {
    let count = 0;
    let lastN = -1;
    return new Promise((resolve) => {
      opts.ipc.on('message', (msg) => {
        count++;
        if (msg && typeof msg.n === 'number') lastN = msg.n;
        opts.ipc.send({ ack: count, last: !!(msg && msg.last), lastN });
        if (msg && msg.last) {
          opts.onStdout('done count=' + count + '\n');
          resolve({ code: 0 });
        }
      });
      opts.ipc.on('disconnect', () => resolve({ code: 0 }));
    });
  }
  return { stdout: '', stderr: '', code: 0 };
};
