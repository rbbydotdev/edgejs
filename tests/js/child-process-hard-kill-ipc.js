// Verifies IPC works on the hard-kill path: child.send(msg) reaches
// the executor's opts.ipc.on('message') and opts.ipc.send(reply)
// surfaces as child.on('message'). On {bye:true} the executor resolves
// so the runner exits naturally.
const { spawn } = require('child_process');

const child = spawn('ipc-echo-killable', [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  killable: 'hard',
});

const replies = [];
child.on('message', (msg) => {
  replies.push(msg);
  if (replies.length === 1) child.send({ n: 2 });
  else if (replies.length === 2) child.send({ bye: true });
});

child.on('exit', (code) => {
  console.log('replies count:', replies.length);
  for (let i = 0; i < replies.length; i++) {
    console.log('  reply', i, JSON.stringify(replies[i]));
  }
  console.log('exit code:', code);
  process.exit(0);
});

child.send({ n: 1 });
