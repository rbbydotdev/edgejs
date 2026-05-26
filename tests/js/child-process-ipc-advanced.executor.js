// Echoes received messages back unchanged. Verifies the round-trip
// preserves types (Map stays Map, Set stays Set, Date stays Date, etc.)
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'clone-echo') {
    return new Promise((resolve) => {
      opts.ipc.on('message', (msg) => {
        opts.ipc.send(msg); // echo
        if (msg && msg.bye) resolve({ code: 0 });
      });
      opts.ipc.on('disconnect', () => resolve({ code: 0 }));
    });
  }
  return { stdout: '', stderr: '', code: 0 };
};
