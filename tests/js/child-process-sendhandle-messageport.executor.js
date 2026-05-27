// Receives a native MessagePort handle via cp.send(msg, port). The
// bridge proxies messages between the user's edge.js port and our
// native port, so we use the native postMessage/onmessage API here.
globalThis.__edgeChildProcessExecutor = async function (cmd, _args, opts) {
  if (cmd === 'port-bridge-echo') {
    return new Promise((resolve) => {
      var port = null;
      opts.ipc.on('message', (msg, handle) => {
        if (handle && typeof handle.postMessage === 'function' && !port) {
          // Got the port. Set up onmessage and ping.
          port = handle;
          port.onmessage = (e) => {
            opts.onStdout('executor got via port: ' + e.data + '\n');
            if (e.data === 'parent-ack') {
              // One round-trip confirmed. Signal "all-done" via the port.
              port.postMessage('all-done');
            }
          };
          port.start && port.start();
          opts.onStdout('executor got msg=' + JSON.stringify(msg) + ' port?=true\n');
          port.postMessage('pong-from-executor');
        } else if (msg && msg.stop) {
          opts.onStdout('executor exiting\n');
          resolve({ code: 0 });
        }
      });
    });
  }
  return { code: 0 };
};
