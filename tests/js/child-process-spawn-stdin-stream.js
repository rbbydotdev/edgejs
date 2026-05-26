// Verifies child.stdin.write() bytes actually reach the executor and
// are read incrementally via opts.stdin (the AsyncIterable<Uint8Array>
// installed by host-worker on P3.2 wiring).
//
// The executor (installed via ?executor64=) does
//   for await (var chunk of opts.stdin) { lines.push(decode(chunk)); }
// then writes 'GOT:<lines.join("|")>\n' to stdout. The test writes 3
// distinct chunks via child.stdin.write() with sleeps between, then
// child.stdin.end(). Expected stdout shows all 3 chunks in order,
// proving the bytes traversed wasm -> sync RPC -> host queue ->
// executor's iterator -> stdout -> reverse RPC -> wasm.
const { spawn } = require('child_process');

const child = spawn('stdin-echo', []);

let captured = '';
child.stdout.on('data', (chunk) => { captured += chunk.toString(); });
child.on('exit', (code) => {
  console.log(captured.trimEnd());
  console.log('exit code:', code);
  process.exit(0);
});

child.stdin.write('one ');
setTimeout(() => {
  child.stdin.write('two ');
  setTimeout(() => {
    child.stdin.write('three');
    child.stdin.end();
  }, 50);
}, 50);
