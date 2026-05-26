// Verifies parent<->child IPC: child.send(msg) reaches the executor's
// opts.ipc.on('message', cb); opts.ipc.send(reply) reaches the parent's
// child.on('message', cb); child.disconnect() fires 'disconnect' both
// sides; child.connected reflects state. Round-trip 3 messages, then
// send {bye:true} to let the child exit cleanly.
const { spawn } = require('child_process');

const child = spawn('ipc-echo', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

let stdoutBuf = '';
child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });

const replies = [];
child.on('message', (msg) => {
  replies.push(msg);
  if (replies.length === 1) child.send({ n: 2 });
  else if (replies.length === 2) child.send({ n: 3 });
  else if (replies.length === 3) child.send({ bye: true });
});

child.on('exit', (code) => {
  console.log('replies count:', replies.length);
  for (let i = 0; i < replies.length; i++) {
    console.log('  reply', i, JSON.stringify(replies[i]));
  }
  console.log('stdout:', stdoutBuf.trim());
  console.log('exit code:', code);
  console.log('connected after exit:', child.connected);
  process.exit(0);
});

// Kick off the first message
child.send({ n: 1 });
