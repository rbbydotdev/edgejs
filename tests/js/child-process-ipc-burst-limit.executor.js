// Same shape as ipc-backpressure but doesn't impose the cap. Lets the
// test surface the actual delivery limit under unbounded burst.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'ipc-burst-limit') {
    let count = 0;
    return new Promise((resolve) => {
      opts.ipc.on('message', (msg) => {
        count++;
        opts.ipc.send({ ack: count, last: !!(msg && msg.last) });
        if (msg && msg.last) resolve({ code: 0 });
      });
      opts.ipc.on('disconnect', () => resolve({ code: 0 }));
    });
  }
  return { stdout: '', stderr: '', code: 0 };
};
