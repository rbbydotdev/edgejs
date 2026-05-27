// Same as the simple advanced-ipc executor: echo received messages.
// Used by the spawned worker_thread's child process.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'clone-echo') {
    return new Promise((resolve) => {
      opts.ipc.on('message', (msg) => {
        opts.ipc.send(msg);
        if (msg && msg.bye) resolve({ code: 0 });
      });
      opts.ipc.on('disconnect', () => resolve({ code: 0 }));
    });
  }
  return { stdout: '', stderr: '', code: 0 };
};
