// A tiny shell stand-in: handles '/bin/sh -c <commandline>' by parsing
// && and ; sequences of plain 'echo TOKEN [TOKEN...]' commands.
// Enough to PROVE the shell:true wrap actually invokes the executor
// with sh + -c + the user's command string.
globalThis.__edgeChildProcessExecutor = async function (cmd, args, _opts) {
  if (cmd === '/bin/sh' || cmd === 'sh' || cmd === 'cmd.exe') {
    // args = ['-c', '<commandline>'] on POSIX, or ['/d','/s','/c','<cmd>'] on win
    let cmdLine = '';
    for (let i = 0; i < args.length; i++) {
      // Accept the first non-flag argument as the command line.
      if (args[i] && !args[i].startsWith('-') && !args[i].startsWith('/')) {
        cmdLine = args[i];
        break;
      }
    }
    if (!cmdLine) return { stdout: '', stderr: 'mock-sh: no command\n', code: 2 };
    // Split on && / ; and run each piece if it's `echo ...`.
    const pieces = cmdLine.split(/&&|;/).map((s) => s.trim()).filter(Boolean);
    let out = '';
    let rc = 0;
    for (const p of pieces) {
      const m = p.match(/^echo\s+(.*)$/);
      if (m) {
        out += m[1] + '\n';
      } else {
        rc = 127;
        break;
      }
    }
    return { stdout: out, code: rc };
  }
  return null;
};
