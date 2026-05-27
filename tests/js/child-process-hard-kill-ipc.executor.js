// Hard-kill-path IPC echo: parrots each incoming message back with a
// running count. Resolves the executor promise on {bye:true} so the
// runner exits naturally (no terminate() needed).
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'ipc-echo-killable') {
    const received = [];
    return new Promise((resolve) => {
      opts.ipc.on('message', (msg) => {
        received.push(msg);
        opts.ipc.send({ echoed: msg, count: received.length });
        if (msg && msg.bye) resolve({ code: 0 });
      });
    });
  }
  return { stdout: '', stderr: '', code: 0 };
};
