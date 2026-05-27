// Echoes messages back. The host-side runner-worker port carries raw
// structured-clone values, so msg arrives with Map/Set/Date/etc.
// types intact and re-clones cleanly on the way back.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'clone-echo-killable') {
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
