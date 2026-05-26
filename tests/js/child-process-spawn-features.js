// Verifies the surface lib drives natively now that we shimmed
// process_wrap.Process + pipe_wrap.Pipe (P3.5): spawnfile, spawnargs,
// child.stdio[] composite, .ref() / .unref(), shell:true wrapping, argv0.
const { spawn } = require('child_process');

const c = spawn('echo', ['hi', 'there']);

console.log('spawnfile:', c.spawnfile);
console.log('spawnargs:', JSON.stringify(c.spawnargs));
console.log('stdio.length:', c.stdio && c.stdio.length);
console.log('stdio[1] is socket:', c.stdio && c.stdio[1] != null && typeof c.stdio[1].on === 'function');
console.log('stdin === stdio[0]:', c.stdin === c.stdio[0]);
console.log('stdout === stdio[1]:', c.stdout === c.stdio[1]);
console.log('stderr === stdio[2]:', c.stderr === c.stdio[2]);
console.log('ref/unref methods:', typeof c.ref === 'function', typeof c.unref === 'function');
console.log('connected:', c.connected);

let buf = '';
c.stdout.on('data', (chunk) => { buf += chunk.toString(); });
c.on('exit', (code) => {
  console.log('echo output:', JSON.stringify(buf.trim()), 'exit:', code);

  // shell:true -- lib's normalizeSpawnArguments wraps the command in
  // /bin/sh -c. Verified by inspecting spawnfile/spawnargs synchronously
  // after spawn returns. We don't wait for exit because our fake shell
  // doesn't know 'sh' (executor would need to handle it).
  const s = spawn('echo hello-from-shell', [], { shell: true });
  console.log('shell:true spawnfile:', s.spawnfile);
  console.log('shell:true args[0]:', s.spawnargs[0]);
  console.log('shell:true args[1]:', s.spawnargs[1]);
  s.on('error', () => {}); // swallow the ENOENT for unknown 'sh' executor

  // argv0 override -- lib passes argv0 through; spawnargs[0] reflects it.
  const a = spawn('echo', ['arg1'], { argv0: 'custom-name' });
  console.log('argv0 spawnargs[0]:', a.spawnargs[0]);
  a.on('exit', () => process.exit(0));
});
