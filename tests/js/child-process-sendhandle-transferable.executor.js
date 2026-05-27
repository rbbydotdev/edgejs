// Receives a transferred ArrayBuffer as the second 'message' arg, reads
// its contents, and writes a summary to stdout before resolving.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'handle-receiver') {
    return new Promise((resolve) => {
      opts.ipc.on('message', (msg, handle) => {
        opts.onStdout('executor msg=' + JSON.stringify(msg) + '\n');
        if (handle instanceof ArrayBuffer) {
          const u32 = new Uint32Array(handle);
          opts.onStdout('handle bytes=' + handle.byteLength + ' u32[0]=0x' + u32[0].toString(16).toUpperCase() + ' u32[1]=0x' + u32[1].toString(16).toUpperCase() + '\n');
        } else {
          opts.onStdout('handle missing or wrong type: ' + (handle && handle.constructor && handle.constructor.name) + '\n');
        }
        resolve({ code: 0 });
      });
    });
  }
  return { code: 0 };
};
