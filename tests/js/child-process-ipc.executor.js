// Host-worker executor for child-process-ipc. Sets up bidirectional
// IPC: each parent->child message is echoed back with a count. On
// {bye: true} or disconnect, writes a final GOT: line and exits.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'ipc-echo') {
    const received = [];
    return new Promise((resolve) => {
      opts.ipc.on('message', (msg) => {
        received.push(msg);
        opts.ipc.send({ echoed: msg, count: received.length });
        if (msg && msg.bye) {
          opts.onStdout('GOT:' + received.length + '\n');
          resolve({ code: 0 });
        }
      });
      opts.ipc.on('disconnect', () => {
        opts.onStdout('GOT:' + received.length + ' (disconnected)\n');
        resolve({ code: 0 });
      });
    });
  }
  return { stdout: '', stderr: '', code: 0 };
};
