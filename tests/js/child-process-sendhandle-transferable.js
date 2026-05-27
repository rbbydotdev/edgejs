// Verifies cp.send(msg, transferable) hands a Transferable to the child
// executor as the second 'message' arg, like Node's cp.send(msg, handle)
// signature -- but for browser-native transferables (ArrayBuffer here)
// instead of OS fds (net.Server / net.Socket) which require a kernel
// for SCM_RIGHTS-style passing.
//
// Limitation discovered while building this: edge.js's MessagePort
// implementation isn't recognized as a native transferable by the host
// structured port's postMessage. ArrayBuffer (and ArrayBuffer-backed
// transferables) work; MessagePort/Readable/WritableStream don't yet --
// would require either replacing edge.js's MessageChannel shim with
// the platform native or building our own port-proxy protocol. Tracked
// in NOTES under child-process-ipc-sendhandle.
const { spawn } = require('child_process');

const child = spawn('handle-receiver', [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  serialization: 'advanced',
});

let stdoutBuf = '';
child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });

child.on('exit', (code) => {
  console.log(stdoutBuf.trimEnd());
  console.log('exit:', code);
  process.exit(0);
});

const payload = new ArrayBuffer(8);
new Uint32Array(payload)[0] = 0xCAFEBABE;
new Uint32Array(payload)[1] = 0xDEADBEEF;

const sent = child.send({ greeting: 'have-a-buffer' }, payload);
console.log('send returned:', sent);
console.log('local buffer byteLength after transfer:', payload.byteLength);
