// Echo any received {payload: ArrayBuffer} back as {echoed: ArrayBuffer}.
// Transfers it again on the way back to fully exercise both directions.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'transfer-echo') {
    return new Promise((resolve) => {
      opts.ipc.on('message', (msg) => {
        if (msg && msg.payload) {
          opts.ipc.send({ echoed: msg.payload }, [msg.payload]);
        }
        if (msg && msg.bye) {
          opts.ipc.send({ bye: true });
          resolve({ code: 0 });
        }
      });
      opts.ipc.on('disconnect', () => resolve({ code: 0 }));
    });
  }
  return { stdout: '', stderr: '', code: 0 };
};
