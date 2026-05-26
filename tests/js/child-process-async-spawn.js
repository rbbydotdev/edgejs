// Verifies async child_process.spawn() returns a ChildProcess emitter,
// fires 'spawn', 'data' on stdout/stderr, 'exit', 'close' in order.
const { spawn, exec, execFile } = require('child_process');

let pending = 5;
function done(label) {
  console.log('done:', label);
  if (--pending === 0) {
    console.log('all done');
    process.exit(0);
  }
}

// 1. spawn -> data + exit
{
  const child = spawn('echo', ['async-spawn-data']);
  let stdoutBuf = '';
  let sawSpawn = false;
  let sawExit = false;
  child.on('spawn', () => { sawSpawn = true; });
  child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
  child.on('exit', (code, sig) => {
    sawExit = true;
    console.log('1. spawn=', sawSpawn, 'data=', JSON.stringify(stdoutBuf.trim()), 'exit code=', code, 'sig=', sig);
  });
  child.on('close', () => {
    console.log('1. close after exit?', sawExit);
    done('spawn');
  });
}

// 2. exec with callback (uses sh -c, which fake shell doesn't know -- expect ENOENT)
{
  exec('echo hello-from-exec', (err, stdout, stderr) => {
    // sh isn't in fake shell -> err.code='ENOENT' OR 'Command failed'
    console.log('2. exec err?', !!err, 'code:', err && err.code);
    done('exec');
  });
}

// 3. execFile with callback
{
  execFile('echo', ['hello-from-execfile'], (err, stdout, stderr) => {
    console.log('3. execFile err?', !!err, 'stdout:', JSON.stringify(stdout.toString().trim()));
    done('execFile');
  });
}

// 4. kill an in-flight child (best effort -- echo is fast, so just verify api)
{
  const child = spawn('echo', ['will-be-killed']);
  // immediately kill; might or might not actually arrive before exit
  child.kill('SIGTERM');
  child.on('close', (code, sig) => {
    console.log('4. kill close, killed?', child.killed);
    done('kill');
  });
}

// 5. spawn unknown command -> error event
{
  const child = spawn('not-a-real-command', []);
  let sawError = false;
  child.on('error', (err) => { sawError = true; });
  child.on('close', (code, sig) => {
    console.log('5. unknown close code:', code, 'errored:', sawError);
    done('unknown');
  });
}
