import type { Policy } from "./index";

// `child_process.spawnSync` etc. in browser-target.
//
// THE PROBLEM
//
// Node's `spawnSync` lands in edge's C++ `SpawnSync` binding which uses
// `uv_spawn` + `uv_run` to block waiting for the child. In browser-target
// `uv_run` ultimately calls a Suspending `poll_oneoff` wasm import. JSPI v2
// forbids suspending when there are JS frames between the promising entry
// (`_start`) and the Suspending import -- and the napi callback boundary IS
// a JS frame. So any sync wait-for-child from a JS-initiated `spawnSync`
// throws `SuspendError`.
//
// THE FIX
//
// Intercept `internalBinding('spawn_sync').spawn` with a JS implementation
// that calls a user-pluggable executor instead of going into C++ + libuv.
// The executor returns a synthetic process result; we shape it into what
// Node's `lib/internal/child_process.js` expects.
//
// MVP SCOPE
//
// - Executor interface is **synchronous**. Returns `{ output, exit }`
//   directly. Async support (real-thread executors, SAB + Atomics.wait
//   bridging) is a future extension; the interface accepts a sync return
//   today and can grow to also accept Promise<> later.
// - Default executor echoes the command name + args back as stdout (so
//   `spawnSync('echo', ['hi'])` returns `"echo hi\n"`). Enough to prove
//   the intercept works end-to-end.
// - Users plug in their own executor by setting
//   `globalThis.__edgeChildProcessExecutor` BEFORE the policy boots
//   (i.e. before edgejs.wasm runs the user script). Example use case:
//   a fake bash that interprets argv as shell commands and produces
//   string output.
//
// USER INTERFACE
//
//   type EdgeChildProcessSpawn = (
//     command: string,
//     args: string[],
//     options: {
//       env?: Record<string, string>;
//       cwd?: string;
//       input?: Uint8Array | string;
//       timeout?: number;
//     }
//   ) => EdgeChildProcessSyncResult;
//
//   interface EdgeChildProcessSyncResult {
//     stdout: Uint8Array | string;
//     stderr: Uint8Array | string;
//     code: number | null;       // null on signal exit
//     signal?: string | null;
//     error?: { code: string; message: string } | null;
//   }
//
// NOT IN MVP (tracked debt; expand as needed)
//
// - `#!~debt child-process-executor-async`: async executor support
//   (Promise return) requires Atomics.wait + a separate worker for the
//   actual work so the Promise can resolve from another thread.
// - `#!~debt child-process-executor-streams`: stdin/stdout streaming.
//   MVP buffers everything.
// - `#!~debt child-process-executor-multi-stdio`: only stdio[0..2] are
//   honored; `stdio[3+]` (extra pipes) is dropped.
// - `#!~debt child-process-async-spawn`: only `spawnSync` is wired;
//   async `spawn`/`exec` still go to the C++ binding which throws.
//
// HOW TO TEST
//
// Set the executor on globalThis from your deployment code or test
// harness, then opt in to the policy via `?policies=child-process-via-executor`.
// See `tests/js/child-process-spawn-echo.js` for the default-executor
// smoke test.

const PRE_PATCH = `
(function installChildProcessViaExecutor() {
  // Idempotent: only patch once per binding instance.
  var binding;
  try { binding = internalBinding('spawn_sync'); } catch (_e) { return; }
  if (!binding || binding.__edgeViaExecutor) return;
  binding.__edgeViaExecutor = true;

  function getGlobalThis() {
    return (typeof globalThis !== 'undefined' && globalThis) ||
           (typeof global !== 'undefined' && global);
  }

  // Resolve the wasm-worker-side sync executor. Returns null if none
  // installed; the caller falls through to the async path (main thread
  // via host RPC) or the default fake shell.
  function resolveLocalExecutor() {
    var g = getGlobalThis();
    var ex = g && g.__edgeChildProcessExecutor;
    if (typeof ex === 'function') return ex;
    return null;
  }

  // Async path. Calls into the worker.ts-installed global that does a
  // sync RPC -> host -> postMessage main -> main's
  // __edgeChildProcessExecutor (sync OR async). Wasm thread blocks on
  // Atomics.wait inside the sync RPC client. Returns the parsed result
  // object, or null if main has no executor installed (sentinel
  // \`__noExecutor: true\`) so the caller falls back to fake shell.
  function tryAsyncPath(command, args, opts) {
    var g = getGlobalThis();
    var spawnSync = g && g.__edgeChildProcessSpawnSync;
    if (typeof spawnSync !== 'function') return null;
    var input = opts && opts.input;
    var inputNums = null;
    if (input != null) {
      if (typeof input === 'string') {
        inputNums = Array.from(new TextEncoder().encode(input));
      } else if (input instanceof Uint8Array) {
        inputNums = Array.from(input);
      }
    }
    var req = {
      command: String(command),
      args: args || [],
      env: opts && opts.env,
      cwd: opts && opts.cwd,
      input: inputNums,
      timeout: opts && typeof opts.timeout === 'number' ? opts.timeout : undefined,
    };
    var replyJson;
    try {
      replyJson = spawnSync(JSON.stringify(req));
    } catch (e) {
      void e;
      return null; // RPC failed; fall back to fake shell.
    }
    var parsed;
    try { parsed = JSON.parse(replyJson); } catch (e) { void e; return null; }
    if (parsed && parsed.__noExecutor) return null; // main has none.
    return {
      stdout: parsed.stdout ? new Uint8Array(parsed.stdout) : '',
      stderr: parsed.stderr ? new Uint8Array(parsed.stderr) : '',
      code: typeof parsed.code === 'number' ? parsed.code : 0,
      signal: parsed.signal != null ? parsed.signal : null,
      error: parsed.error || null,
    };
  }

  // Default executor: a tiny fake shell with a handful of authentic
  // UNIX commands. Enough to demonstrate the executor interface and
  // make trivial spawnSync calls do what callers expect ("echo hi"
  // returns "hi\\n"). Users who need more should install their own
  // executor; see file header.
  //
  // Command resolution: matches by basename (so /bin/echo, ./echo,
  // and "echo" all hit the same handler).
  function basename(p) {
    var s = String(p || '');
    var i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
  }

  var FAKE_SHELL = {
    // \`echo [-n] [args...]\` -- args joined by space, newline unless -n.
    echo: function(args, _opts) {
      var noNewline = false;
      var i = 0;
      if (args[0] === '-n') { noNewline = true; i = 1; }
      var out = args.slice(i).join(' ');
      return { stdout: noNewline ? out : out + '\\n', stderr: '', code: 0 };
    },
    // \`true\` -- exit 0, no output. \`false\` -- exit 1, no output.
    true: function() { return { stdout: '', stderr: '', code: 0 }; },
    false: function() { return { stdout: '', stderr: '', code: 1 }; },
    // \`cat\` -- write stdin to stdout (file args not supported in MVP).
    cat: function(_args, opts) {
      var input = opts && opts.input;
      if (input == null) input = '';
      if (input instanceof Uint8Array) {
        return { stdout: input, stderr: '', code: 0 };
      }
      return { stdout: String(input), stderr: '', code: 0 };
    },
    // \`env\` -- print KEY=VALUE for each env var, one per line.
    env: function(_args, opts) {
      var env = (opts && opts.env) || {};
      var lines = [];
      for (var k in env) {
        if (Object.prototype.hasOwnProperty.call(env, k)) {
          lines.push(k + '=' + env[k]);
        }
      }
      return { stdout: lines.join('\\n') + (lines.length ? '\\n' : ''), stderr: '', code: 0 };
    },
    // \`pwd\` -- print cwd.
    pwd: function(_args, opts) {
      var cwd = (opts && opts.cwd) || '/';
      return { stdout: cwd + '\\n', stderr: '', code: 0 };
    },
  };

  function defaultFakeShellExecutor(command, args, opts) {
    var name = basename(command);
    var handler = FAKE_SHELL[name];
    if (typeof handler === 'function') {
      try {
        var res = handler(args || [], opts || {});
        // Normalize: missing fields default sensibly.
        return {
          stdout: res.stdout != null ? res.stdout : '',
          stderr: res.stderr != null ? res.stderr : '',
          code: typeof res.code === 'number' ? res.code : 0,
          signal: res.signal != null ? res.signal : null,
          error: res.error || null,
        };
      } catch (e) {
        return {
          stdout: '', stderr: String(e && e.message ? e.message : e), code: 1,
          signal: null,
          error: { code: 'EFAKESHELL', message: String(e && e.message ? e.message : e) },
        };
      }
    }
    // Unknown command: behave like a real shell -- ENOENT, exit 127.
    return {
      stdout: '',
      stderr: name + ': command not found\\n',
      code: 127,
      signal: null,
      error: { code: 'ENOENT', message: 'spawn ' + name + ' ENOENT' },
    };
  }

  // Return Buffer so lib's downstream + user code can call .toString()
  // and get the utf8 decode they expect from Node's spawnSync result.
  // Uint8Array.toString() returns the joined-numbers string, which is
  // confusing and breaks every realistic test assertion.
  function toBuffer(v) {
    if (v == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (typeof v === 'string') return Buffer.from(v, 'utf8');
    return Buffer.from(String(v), 'utf8');
  }

  // edge.js's C++ SpawnSync returns a result object whose shape matches
  // what lib's internal/child_process.js expects:
  //   { pid: 0, output: [stdin, stdout, stderr], stdout, stderr,
  //     status: 0|null, signal: null|str, error: Error|null }
  // Build that shape from the executor's simpler return value.
  function shapeResult(execResult, options) {
    var stdoutBytes = toBuffer(execResult.stdout);
    var stderrBytes = toBuffer(execResult.stderr);

    // Node's lib uses Buffers; we use Uint8Array, which Buffer.from()
    // wraps cheaply. lib will Buffer-ify when needed downstream.
    var stdio = options && options.stdio ? options.stdio : [];
    var output = new Array(Math.max(3, stdio.length || 3));
    // output[0] is stdin -- always null on result.
    output[0] = null;
    output[1] = stdoutBytes;
    output[2] = stderrBytes;
    // Higher stdio slots not supported -- fill with null.
    for (var i = 3; i < output.length; i++) output[i] = null;

    var result = {
      pid: 0,
      output: output,
      stdout: stdoutBytes,
      stderr: stderrBytes,
      status: execResult.code,
      signal: execResult.signal != null ? execResult.signal : null,
      error: null,
    };
    // lib's internal/child_process.js spawnSync wraps result.error via
    // \`new ErrnoException(result.error, 'spawnSync ' + file)\` -- which
    // expects a libuv error NUMBER (negative). If our executor reports
    // an error code as a string ('ENOENT'), map to the closest libuv
    // numeric code. Unknown codes default to -EINVAL.
    if (execResult.error) {
      var code = execResult.error.code;
      var n = -22; // EINVAL
      if (code === 'ENOENT' || code === 'ESPAWN') n = -2;
      else if (code === 'EACCES') n = -13;
      else if (code === 'EPERM') n = -1;
      else if (code === 'ENOMEM') n = -12;
      else if (code === 'ETIMEDOUT') n = -110;
      else if (typeof code === 'number') n = code;
      result.error = n;
    }
    return result;
  }

  binding.spawn = function spawn(options) {
    if (!options || typeof options !== 'object') {
      var err = new TypeError('options must be an object');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    var command = String(options.file != null ? options.file : '');
    var args = Array.isArray(options.args) ? options.args.slice(1) : [];
    // env_pairs is a string[] of "KEY=VALUE" -- repack into a map for
    // the executor's friendlier interface.
    var env;
    if (Array.isArray(options.envPairs)) {
      env = {};
      for (var i = 0; i < options.envPairs.length; i++) {
        var kv = String(options.envPairs[i]);
        var eq = kv.indexOf('=');
        if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }
    // stdin: lib passes input bytes as options.stdio[0].input.
    var input = null;
    if (Array.isArray(options.stdio) && options.stdio.length > 0) {
      var s0 = options.stdio[0];
      if (s0 && s0.input != null) input = s0.input;
    }
    // Three-tier executor resolution:
    //   1. wasm-worker sync executor (fast path, no RPC)
    //   2. main-thread executor via host RPC (async-capable)
    //   3. default fake shell (sync, on wasm-worker)
    var execOpts = {
      env: env,
      cwd: options.cwd != null ? String(options.cwd) : undefined,
      input: input,
      timeout: typeof options.timeout === 'number' ? options.timeout : undefined,
    };
    var execResult;
    var localExec = resolveLocalExecutor();
    try {
      if (localExec) {
        execResult = localExec(command, args, execOpts);
        // If local executor returned a Promise (async), it can't be
        // awaited on the wasm thread -- fall through to the async path.
        if (execResult && typeof execResult.then === 'function') {
          execResult = tryAsyncPath(command, args, execOpts);
        }
      } else {
        // No local executor: try async-via-main first, then default.
        execResult = tryAsyncPath(command, args, execOpts);
      }
      // Either path returned null/undefined -> default fake shell.
      if (execResult == null) {
        execResult = defaultFakeShellExecutor(command, args, execOpts);
      }
    } catch (e) {
      // Executor itself threw -- surface as a spawn error (-EINVAL).
      void e;
      return {
        pid: 0,
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: null,
        error: -22,
      };
    }
    // Defensive: execResult should be a plain result object at this
    // point (we routed Promises through tryAsyncPath above).
    if (execResult && typeof execResult.then === 'function') {
      return {
        pid: 0,
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: null,
        error: -38, // ENOSYS
      };
    }
    return shapeResult(execResult || {}, options);
  };
})();
`;

export const childProcessViaExecutor: Policy = {
  name: "child-process-via-executor",
  description:
    "Replace internalBinding('spawn_sync').spawn with a JS impl that delegates to a user-pluggable executor (default: echo). Avoids the JSPI SuspendError from native spawn_sync's uv_run loop.",
  builtinOverrides: {
    "internal/child_process": { pre: PRE_PATCH },
  },
};
