// Verifies cp.send(msg, MessagePort) bridges an edge.js MessagePort to
// a native MessageChannel and transfers the native port to the executor.
// User code uses the Node-style MessagePort API on the sending side;
// the executor receives a native MessagePort it can postMessage on.
// Bidirectional message flow confirms the bridge proxies both directions.
const { spawn } = require('child_process');

const child = spawn('port-bridge-echo', [], {
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

// Create an edge.js MessageChannel and keep one port; send the other.
const { MessageChannel } = require('worker_threads');
const channel = new MessageChannel();
const myPort = channel.port1;
const theirPort = channel.port2;

let bridgeMsgsReceived = 0;
myPort.on('message', (msg) => {
  bridgeMsgsReceived++;
  if (msg === 'pong-from-executor') {
    // Echo back to confirm bridge round-trip works.
    myPort.postMessage('parent-ack');
  } else if (msg === 'all-done') {
    console.log('bridge round-trips:', bridgeMsgsReceived);
    // Test is done; signal child to exit.
    child.send({ stop: true });
  }
});
myPort.start();

// Hand the port to the executor as the sendHandle.
child.send({ greeting: 'hello-port' }, theirPort);
