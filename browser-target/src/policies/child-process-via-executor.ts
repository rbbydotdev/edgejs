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
  // sync RPC to the host worker, which runs the user-installed executor
  // (installed via host-worker init bootScript) in its own event loop.
  // Wasm thread blocks on Atomics.wait inside the sync RPC client.
  //
  // WIRE FORMAT (binary frame, replaces the previous JSON-bytes-as-numbers
  // encoding which was ~6x bloat on stdio data). All integers LE u32.
  //
  // Request:
  //   [u32 headerLen][header utf-8 JSON][u32 inputLen][input bytes]
  // Header JSON: { command, args, env?, cwd?, timeout?, killSignal? }
  //
  // Reply:
  //   [u32 headerLen][header utf-8 JSON][u32 stdoutLen][stdout][u32 stderrLen][stderr]
  // Header JSON: { code, signal, error?, __noExecutor? }
  //
  // SAB slot size limit (~4 KiB) caps combined payload size. Larger
  // stdio (> a few KB) needs the shared napi-mem path; documented as
  // a follow-up. The binary frame at least 6x's the in-slot capacity
  // vs JSON-encoded number arrays.
  function packRequest(command, args, opts, inputBytes) {
    var header = {
      command: String(command),
      args: args || [],
      env: opts && opts.env,
      cwd: opts && opts.cwd,
      timeout: opts && typeof opts.timeout === 'number' ? opts.timeout : undefined,
      killSignal: opts && opts.killSignal,
    };
    var headerBytes = new TextEncoder().encode(JSON.stringify(header));
    var inLen = inputBytes ? inputBytes.byteLength : 0;
    var totalLen = 4 + headerBytes.byteLength + 4 + inLen;
    var buf = new Uint8Array(totalLen);
    var dv = new DataView(buf.buffer);
    dv.setUint32(0, headerBytes.byteLength, true);
    buf.set(headerBytes, 4);
    dv.setUint32(4 + headerBytes.byteLength, inLen, true);
    if (inLen > 0) buf.set(inputBytes, 4 + headerBytes.byteLength + 4);
    return buf;
  }

  function unpackReply(buf) {
    if (!buf || buf.byteLength < 4) return null;
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var headerLen = dv.getUint32(0, true);
    if (4 + headerLen + 8 > buf.byteLength) return null;
    var header;
    try {
      header = JSON.parse(new TextDecoder('utf-8').decode(
        buf.subarray(4, 4 + headerLen)));
    } catch (e) { void e; return null; }
    if (header && header.__noExecutor) return { __noExecutor: true };
    var outLen = dv.getUint32(4 + headerLen, true);
    var outStart = 4 + headerLen + 4;
    if (outStart + outLen + 4 > buf.byteLength) return null;
    var errLen = dv.getUint32(outStart + outLen, true);
    var errStart = outStart + outLen + 4;
    if (errStart + errLen > buf.byteLength) return null;
    // Copy out (the buf is a transient view over the SAB slot).
    var stdoutBytes = new Uint8Array(outLen);
    if (outLen > 0) stdoutBytes.set(buf.subarray(outStart, outStart + outLen));
    var stderrBytes = new Uint8Array(errLen);
    if (errLen > 0) stderrBytes.set(buf.subarray(errStart, errStart + errLen));
    return {
      stdout: stdoutBytes,
      stderr: stderrBytes,
      code: typeof header.code === 'number' ? header.code : null,
      signal: header.signal != null ? header.signal : null,
      error: header.error || null,
    };
  }

  function tryAsyncPath(command, args, opts) {
    var g = getGlobalThis();
    var spawnSync = g && g.__edgeChildProcessSpawnSync;
    if (typeof spawnSync !== 'function') return null;
    var input = opts && opts.input;
    var inputBytes = null;
    if (input != null) {
      if (typeof input === 'string') inputBytes = new TextEncoder().encode(input);
      else if (input instanceof Uint8Array) inputBytes = input;
    }
    var reqBuf = packRequest(command, args, opts, inputBytes);
    var replyBuf;
    try {
      replyBuf = spawnSync(reqBuf);
    } catch (e) {
      void e;
      return null; // RPC failed; fall back to fake shell.
    }
    var parsed = unpackReply(replyBuf);
    if (parsed && parsed.__noExecutor) return null;
    return parsed;
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

  // Convert string signal name to numeric (NodeJS conventional values)
  // so we have a value either way. lib's spawnSync expects the signal
  // field to be a STRING -- a wrapper post-patch below ensures that.
  var SIG_NAME_TO_NUM = {
    SIGHUP:1, SIGINT:2, SIGQUIT:3, SIGILL:4, SIGTRAP:5, SIGABRT:6, SIGBUS:7,
    SIGFPE:8, SIGKILL:9, SIGUSR1:10, SIGSEGV:11, SIGUSR2:12, SIGPIPE:13,
    SIGALRM:14, SIGTERM:15, SIGCHLD:17, SIGCONT:18, SIGSTOP:19, SIGTSTP:20,
  };
  var SIG_NUM_TO_NAME = {};
  for (var sk in SIG_NAME_TO_NUM) {
    if (Object.prototype.hasOwnProperty.call(SIG_NAME_TO_NUM, sk)) {
      SIG_NUM_TO_NAME[SIG_NAME_TO_NUM[sk]] = sk;
    }
  }
  function normalizeSignalToName(s) {
    if (s == null) return null;
    if (typeof s === 'string') {
      // Already a name? Could also be a stringified number ("9").
      return SIG_NAME_TO_NUM[s] ? s
        : (SIG_NUM_TO_NAME[Number(s)] || s);
    }
    if (typeof s === 'number') return SIG_NUM_TO_NAME[s] || ('SIG' + s);
    return null;
  }

  // edge.js's C++ SpawnSync returns a result object whose shape matches
  // what lib's internal/child_process.js expects:
  //   { pid: 0, output: [stdin, stdout, stderr], stdout, stderr,
  //     status: 0|null, signal: null|str, error: Error|null }
  // Build that shape from the executor's simpler return value.
  //
  // ERROR REPRESENTATION:
  //
  // lib's spawnSync wraps result.error via \`new ErrnoException(N, ...)\`
  // which expects a libuv error NUMBER and maps N -> error.code via
  // util.getSystemErrorName. The number-to-code mapping is build-specific
  // (wasi-libc differs from macOS / Linux libuv), so hardcoding negative
  // numbers (like -110 for ETIMEDOUT) is wrong on our build.
  //
  // Instead we leave result.error null in the binding, attach a
  // \`__edgeError\` marker carrying the exact string code we want, and
  // a post-patch on lib's spawnSync re-constructs result.error from the
  // marker. That sidesteps the libuv-number mapping entirely.
  //
  // MAXBUFFER:
  //
  // Node spawnSync default is 1 MB per stream. If exceeded we truncate
  // the buffers to maxBuffer and surface an ENOBUFS error. We mark
  // status=null, signal=killSignal (Node's behavior is to kill the
  // child when the limit is hit).
  function shapeResult(execResult, options) {
    var stdoutBytes = toBuffer(execResult.stdout);
    var stderrBytes = toBuffer(execResult.stderr);

    var maxBuffer = (options && typeof options.maxBuffer === 'number' && options.maxBuffer > 0)
      ? options.maxBuffer : 1024 * 1024;
    var maxBufExceeded = false;
    if (stdoutBytes.length > maxBuffer) {
      stdoutBytes = stdoutBytes.subarray(0, maxBuffer);
      maxBufExceeded = true;
    }
    if (stderrBytes.length > maxBuffer) {
      stderrBytes = stderrBytes.subarray(0, maxBuffer);
      maxBufExceeded = true;
    }

    var stdio = options && options.stdio ? options.stdio : [];
    var output = new Array(Math.max(3, stdio.length || 3));
    output[0] = null;
    output[1] = stdoutBytes;
    output[2] = stderrBytes;
    for (var i = 3; i < output.length; i++) output[i] = null;

    var signalName = normalizeSignalToName(execResult.signal);
    var result = {
      pid: 0,
      output: output,
      stdout: stdoutBytes,
      stderr: stderrBytes,
      status: (maxBufExceeded || signalName != null) ? null : execResult.code,
      signal: signalName,
      error: null,
    };
    if (maxBufExceeded) {
      result.__edgeError = {
        code: 'ENOBUFS',
        message: 'stdout maxBuffer length exceeded',
        syscall: 'spawnSync ' + String(options && options.file != null ? options.file : ''),
      };
      // Mark signal too -- Node kills the child when maxBuffer exceeded.
      result.signal = signalName || normalizeSignalToName(options && options.killSignal) || 'SIGTERM';
      return result;
    }
    if (execResult.error) {
      result.__edgeError = {
        code: execResult.error.code || 'ESPAWN',
        message: execResult.error.message || String(execResult.error.code || 'spawn error'),
        syscall: 'spawnSync ' + String(options && options.file != null ? options.file : ''),
      };
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
    // stdout/stderr stdio mode: 'pipe' (capture into result, default),
    // 'inherit' (write to wasm's process.stdout/stderr), 'ignore' (drop).
    // For 'inherit' we route the executor's output through process.stdout/stderr
    // AFTER the executor returns -- bounded buffering, no real-time streaming
    // (that's P3). Real-time streaming requires async spawn.
    function stdioModeOf(idx, defaultMode) {
      if (!Array.isArray(options.stdio) || options.stdio.length <= idx) return defaultMode;
      var s = options.stdio[idx];
      if (!s) return defaultMode;
      if (typeof s === 'string') return s;
      if (s.type === 'inherit') return 'inherit';
      if (s.type === 'ignore') return 'ignore';
      // 'pipe', 'overlapped', 'fd', 'wrap', null -> capture (best effort).
      return 'pipe';
    }
    var stdoutMode = stdioModeOf(1, 'pipe');
    var stderrMode = stdioModeOf(2, 'pipe');
    // Three-tier executor resolution:
    //   1. wasm-worker sync executor (fast path, no RPC)
    //   2. host-worker async executor via sync RPC (async-capable)
    //   3. default fake shell (sync, on wasm-worker)
    //
    // Node's killSignal default is 'SIGTERM' (per spawnSync docs).
    var execOpts = {
      env: env,
      cwd: options.cwd != null ? String(options.cwd) : undefined,
      input: input,
      timeout: typeof options.timeout === 'number' && options.timeout > 0
        ? options.timeout : undefined,
      killSignal: options.killSignal != null ? String(options.killSignal) : 'SIGTERM',
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
    execResult = execResult || {};

    // Apply stdout/stderr stdio modes: 'inherit' writes through to
    // the wasm's process.stdout / process.stderr; 'ignore' drops the
    // bytes. 'pipe' passes through to shapeResult (default capture).
    function applyMode(bytes, mode, fd) {
      if (bytes == null) return bytes;
      if (mode === 'ignore') return ''; // drop
      if (mode === 'inherit') {
        var stream = (fd === 1 ? process.stdout : process.stderr);
        if (stream && typeof stream.write === 'function') {
          try { stream.write(bytes); } catch (e) { void e; }
        }
        return ''; // not captured in result
      }
      return bytes; // 'pipe' default -- capture
    }
    if (stdoutMode !== 'pipe') {
      execResult.stdout = applyMode(execResult.stdout, stdoutMode, 1);
    }
    if (stderrMode !== 'pipe') {
      execResult.stderr = applyMode(execResult.stderr, stderrMode, 2);
    }
    return shapeResult(execResult, options);
  };
})();
`;

// Post-patch on lib/internal/child_process: wrap the exported spawnSync
// so when our binding attached a __edgeError marker on the result, we
// reconstruct result.error from it AFTER lib's ErrnoException wrap.
// This lets us deliver an Error with the EXACT code we want (e.g.
// 'ETIMEDOUT', 'ENOBUFS') without depending on the build-specific
// libuv error-number mapping.
const POST_PATCH = `
(function installSpawnSyncErrorPostPatch() {
  if (!module || !module.exports || typeof module.exports.spawnSync !== 'function') return;
  if (module.exports.__edgeSpawnSyncWrapped) return;
  var orig = module.exports.spawnSync;
  module.exports.spawnSync = function(options) {
    var r = orig.call(this, options);
    if (r && r.__edgeError) {
      var info = r.__edgeError;
      var err = new Error(info.message || ('spawn ' + info.code));
      err.code = info.code;
      err.errno = 0;
      err.syscall = info.syscall || 'spawnSync';
      if (options && options.file) err.path = options.file;
      if (options && Array.isArray(options.args)) {
        err.spawnargs = options.args.slice(1);
      }
      r.error = err;
      delete r.__edgeError;
    }
    return r;
  };
  module.exports.__edgeSpawnSyncWrapped = true;
})();
`;

export const childProcessViaExecutor: Policy = {
  name: "child-process-via-executor",
  description:
    "Replace internalBinding('spawn_sync').spawn with a JS impl that delegates to a user-pluggable executor (default: small fake shell). Avoids the JSPI SuspendError from native spawn_sync's uv_run loop. Supports sync executors on the wasm worker (fast path) and async executors on the host worker (via sync RPC + Atomics.wait).",
  builtinOverrides: {
    "internal/child_process": { pre: PRE_PATCH, post: POST_PATCH },
  },
};
