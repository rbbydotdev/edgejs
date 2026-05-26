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
// SHIPPED (no longer debt)
//
// - Async executor: opts.onStdout/onStderr stream chunks incrementally
//   (P3.1). opts.stdin AsyncIterable receives chunks pushed from
//   wasm-side child.stdin.write() in real time (P3.2). spawn() / exec()
//   / execFile() all return ChildProcess facades that round-trip via
//   the host-worker executor.
//
// REMAINING DEBT
//
// - `#!~debt child-process-executor-multi-stdio`: only stdio[0..2] are
//   honored; `stdio[3+]` (extra pipes) is dropped. Real Node supports
//   N additional pipes for IPC / file-descriptor passing; we don't.
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

    // options.signal (AbortSignal): Node's spawnSync ignores this in
    // practice (sync call can't react to mid-call abort since the JS
    // event loop is blocked). We do a pre-check at entry: if the
    // signal is already aborted, return immediately with an
    // AbortError-shaped result. Doesn't forward the signal to the
    // executor (would need a bidirectional abort channel across
    // threads; the executor can implement its own timeout instead).
    if (options.signal && options.signal.aborted) {
      var killSig = normalizeSignalToName(options.killSignal) || 'SIGTERM';
      return {
        pid: 0,
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: killSig,
        error: null,
        __edgeError: {
          code: 'ABORT_ERR',
          message: 'The operation was aborted',
          syscall: 'spawnSync ' + command,
        },
      };
    }
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

// Post-patch on lib/internal/child_process: wraps the exported spawnSync
// so when our binding attached a __edgeError marker on the result, we
// reconstruct result.error from it AFTER lib's ErrnoException wrap.
// Sidesteps the build-specific libuv error-number mapping; lets us
// deliver an Error with the EXACT code we want (e.g. 'ETIMEDOUT',
// 'ENOBUFS').
const INTERNAL_POST_PATCH = `
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

// Post-patch on PUBLIC \`child_process\`: installs the EdgeChildProcess
// async impl that replaces lib's exports.spawn / .exec / .execFile.
//
// Must run on the public module (not \`internal/child_process\`) because
// the public module forwards spawn/exec/execFile through wrappers that
// touch the internal ChildProcess class -- patching internal mid-load
// is racy with the circular require chain. By the time the public
// module finishes loading, exports.spawn etc. are stable and ours
// to replace cleanly.
const PUBLIC_POST_PATCH = `
(function installSpawnAsyncSupport() {
  var g = (typeof globalThis !== 'undefined' && globalThis) ||
          (typeof global !== 'undefined' && global);
  var startAsync = g && g.__edgeChildProcessSpawnAsync;
  var killAsync  = g && g.__edgeChildProcessKillAsync;
  if (typeof startAsync !== 'function' || typeof killAsync !== 'function') {
    // Async wiring not installed on this worker -- e.g. node-harness path.
    // Leave lib's ChildProcess intact; spawnSync still works via the
    // sync-RPC pre-patch above.
    return;
  }
  if (g.__edgeChildProcessAsyncInstalled) return;
  g.__edgeChildProcessAsyncInstalled = true;

  var EventEmitter = require('events');
  var stream = require('stream');

  // Per-child callback registry. childId -> handler(kind, payload).
  // Populated by EdgeChildProcess constructor; consumed by the global
  // __edgeChildProcessAsyncEvent dispatcher we install once.
  var childHandlers = new Map();

  // Per-child event buffer. Holds events that arrived BEFORE the
  // constructor finished registering a handler -- inevitable because
  // the executor (running on the host worker) may start emitting
  // chunks as soon as the START reply is en route. Without this buffer
  // we'd silently drop the first events. The buffer is drained when
  // the handler registers; entries are removed when 'exit' fires
  // (childHandlers.delete is the signal).
  var pendingEvents = new Map();

  // Install the event dispatcher exactly once. The reverse-RPC handler
  // in worker.ts routes incoming OP_SPAWN_ASYNC_EVENT payloads here.
  g.__edgeChildProcessAsyncEvent = function(childId, kind, payload) {
    var h = childHandlers.get(childId);
    if (h) {
      h(kind, payload);
      return;
    }
    // Handler not yet registered -- buffer until EdgeChildProcess
    // constructor calls registerChildHandler(childId, h). Race window:
    // the executor (running in host-worker) can begin emitting chunks
    // synchronously, before the wasm-side START reply has come back
    // and we've populated childHandlers. Without buffering, those
    // earliest chunks would be silently dropped.
    var buf = pendingEvents.get(childId);
    if (!buf) { buf = []; pendingEvents.set(childId, buf); }
    buf.push([kind, payload]);
  };

  function registerChildHandler(childId, handler) {
    childHandlers.set(childId, handler);
    var buffered = pendingEvents.get(childId);
    if (buffered) {
      pendingEvents.delete(childId);
      for (var i = 0; i < buffered.length; i++) {
        handler(buffered[i][0], buffered[i][1]);
      }
    }
  }

  // Loop-keepalive. Our async ChildProcess has no underlying libuv
  // handle -- it's pure JS waiting on reverse-RPC events from the
  // host worker. Without something ref'd in the loop, Node decides
  // \`uv_loop_alive() === false\` and exits before our events arrive.
  // A single refed setInterval, ref-counted to the number of pending
  // children, holds the loop open. Cheap (no-op tick every 50ms) but
  // mandatory for correctness -- spawn() returning without ever
  // firing 'exit' would otherwise be the norm.
  var keepaliveTimer = null;
  var pendingChildren = 0;
  function keepaliveAcquire() {
    pendingChildren++;
    if (keepaliveTimer == null) {
      keepaliveTimer = setInterval(function() {}, 50);
    }
  }
  function keepaliveRelease() {
    if (pendingChildren > 0) pendingChildren--;
    if (pendingChildren === 0 && keepaliveTimer != null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  // Packing helper -- mirrors child-process-via-executor.ts packRequest.
  function packRequestForAsync(file, args, opts) {
    var headerObj = {
      command: String(file),
      args: Array.isArray(args) ? args.slice(1).map(String) : [],
      env: opts && opts.env,
      cwd: opts && opts.cwd,
      timeout: opts && typeof opts.timeout === 'number' ? opts.timeout : undefined,
      killSignal: opts && opts.killSignal,
    };
    var headerBytes = new TextEncoder().encode(JSON.stringify(headerObj));
    var input = null;
    if (opts && opts.stdio && Array.isArray(opts.stdio) && opts.stdio.length > 0) {
      var s0 = opts.stdio[0];
      if (s0 && s0.input != null) {
        input = (s0.input instanceof Uint8Array)
          ? s0.input
          : new TextEncoder().encode(String(s0.input));
      }
    }
    var inLen = input ? input.byteLength : 0;
    var totalLen = 4 + headerBytes.byteLength + 4 + inLen;
    var buf = new Uint8Array(totalLen);
    var dv = new DataView(buf.buffer);
    dv.setUint32(0, headerBytes.byteLength, true);
    buf.set(headerBytes, 4);
    dv.setUint32(4 + headerBytes.byteLength, inLen, true);
    if (input) buf.set(input, 4 + headerBytes.byteLength + 4);
    return buf;
  }

  // EdgeChildProcess: shape compatible with lib's ChildProcess users
  // (EventEmitter with .stdin/.stdout/.stderr/.pid/.kill).
  function EdgeChildProcess(file, args, options) {
    EventEmitter.call(this);
    var self = this;
    this._file = file;
    this._args = args || [];
    this._options = options || {};
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    // Default to PassThrough streams unless stdio mode says otherwise.
    var stdoutMode = stdioModeOfAsync(this._options.stdio, 1);
    var stderrMode = stdioModeOfAsync(this._options.stdio, 2);
    this.stdout = (stdoutMode === 'pipe') ? new stream.PassThrough() : null;
    this.stderr = (stderrMode === 'pipe') ? new stream.PassThrough() : null;
    // child.stdin: a Writable that forwards each chunk to the host
    // executor via sync RPC. _write fires per chunk; _final on .end().
    // Sync RPC briefly blocks the wasm event loop (microseconds for
    // a queue push -- no real I/O); same trade-off as the spawn/kill
    // sync RPCs already in use. The pre-spawn _childId guard handles
    // the brief window before the START reply arrives where writes
    // are buffered locally until _childId is set in the constructor's
    // success path. Default Writable buffers internally; once _childId
    // exists, the underlying writes drain via the highWaterMark queue.
    if (stdioModeOfAsync(this._options.stdio, 0) === 'pipe') {
      var childRef = this;
      this.stdin = new stream.Writable({
        write: function(chunk, _enc, cb) {
          if (childRef._childId == null) { cb(); return; } // started==failed path
          var bytes = Buffer.isBuffer(chunk) ? chunk
            : (chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk)));
          var writer = g.__edgeChildProcessStdinWrite;
          if (typeof writer === 'function') {
            try { writer(childRef._childId, bytes); }
            catch (e) { cb(e); return; }
          }
          cb();
        },
        final: function(cb) {
          if (childRef._childId == null) { cb(); return; }
          var ender = g.__edgeChildProcessStdinEnd;
          if (typeof ender === 'function') {
            try { ender(childRef._childId); }
            catch (e) { cb(e); return; }
          }
          cb();
        },
      });
    } else {
      this.stdin = null;
    }

    var requestBytes = packRequestForAsync(file, args, this._options);
    var started = startAsync(requestBytes);
    if (started.status !== 0) {
      // Schedule synthetic ENOENT/ESPAWN error in next tick (Node
      // emits 'error' asynchronously when the binding spawn fails).
      // Acquire+release keepalive across the nextTick so the loop
      // stays alive long enough for our error+close to fire.
      this.pid = undefined;
      keepaliveAcquire();
      process.nextTick(function() {
        var err = new Error('spawn ' + file + ' ENOENT');
        err.code = (started.status === -2) ? 'ENOENT' : 'ESPAWN';
        err.errno = started.status;
        err.syscall = 'spawn ' + file;
        err.path = file;
        err.spawnargs = self._args.slice(1);
        self.emit('error', err);
        if (self.stdout) self.stdout.end();
        if (self.stderr) self.stderr.end();
        self.emit('close', null, null);
        keepaliveRelease();
      });
      return;
    }
    this._childId = started.childId;
    // Pin the event loop until 'close' fires. Without this, scripts
    // that just spawn() and wait would drain immediately because
    // our async child has no libuv handle backing it.
    keepaliveAcquire();
    // Register per-child event handler. registerChildHandler drains any
    // events that arrived before this point -- normal when the executor
    // starts emitting before the START reply has reached us.
    registerChildHandler(this._childId, function(kind, payload) {
      if (kind === 4 /*spawned*/) {
        // Use childId as pid (we don't have real OS pids).
        self.pid = self._childId;
        self.emit('spawn');
      } else if (kind === 0 /*stdout*/) {
        if (self.stdout) self.stdout.write(payload);
        else if (stdoutMode === 'inherit') process.stdout.write(payload);
      } else if (kind === 1 /*stderr*/) {
        if (self.stderr) self.stderr.write(payload);
        else if (stderrMode === 'inherit') process.stderr.write(payload);
      } else if (kind === 3 /*error*/) {
        var raw = new TextDecoder().decode(payload);
        var errCode = 'ESPAWN';
        var errMsg = raw || 'spawn error';
        // Host emits JSON {code, message} for structured errors; fall back
        // to raw text for legacy/non-JSON payloads.
        try {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            if (parsed.code) errCode = String(parsed.code);
            if (parsed.message) errMsg = String(parsed.message);
          }
        } catch (e) { void e; }
        var err = new Error(errMsg);
        err.code = errCode;
        err.syscall = 'spawn ' + self._file;
        err.path = self._file;
        err.spawnargs = self._args.slice(1);
        self.emit('error', err);
      } else if (kind === 2 /*exit*/) {
        // payload: [i32 code | -1 null][u32 sigLen][utf-8 sig]
        var dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        var codeRaw = dv.getInt32(0, true);
        var sigLen = dv.getUint32(4, true);
        var sig = sigLen > 0
          ? new TextDecoder().decode(payload.subarray(8, 8 + sigLen))
          : null;
        var code = (codeRaw === -1 && sig != null) ? null : codeRaw;
        self.exitCode = code;
        self.signalCode = sig;
        self.emit('exit', code, sig);
        // End streams then emit 'close' (matches Node ordering).
        if (self.stdout) self.stdout.end();
        if (self.stderr) self.stderr.end();
        process.nextTick(function() {
          self.emit('close', code, sig);
          keepaliveRelease();
        });
        childHandlers.delete(self._childId);
      }
    });
  }
  Object.setPrototypeOf(EdgeChildProcess.prototype, EventEmitter.prototype);
  EdgeChildProcess.prototype.kill = function(signal) {
    if (this.killed || this._childId == null) return false;
    this.killed = true;
    return killAsync(this._childId, signal != null ? String(signal) : 'SIGTERM');
  };
  EdgeChildProcess.prototype.ref = function() {}; // no-op
  EdgeChildProcess.prototype.unref = function() {}; // no-op
  EdgeChildProcess.prototype.disconnect = function() {}; // no-op (no IPC)

  function stdioModeOfAsync(stdioOpt, idx) {
    var defaultMode = 'pipe';
    if (!Array.isArray(stdioOpt)) {
      if (stdioOpt === 'inherit' || stdioOpt === 'ignore' || stdioOpt === 'pipe') {
        return stdioOpt;
      }
      return defaultMode;
    }
    var s = stdioOpt[idx];
    if (!s) return defaultMode;
    if (typeof s === 'string') return s;
    if (s.type === 'inherit') return 'inherit';
    if (s.type === 'ignore') return 'ignore';
    return 'pipe';
  }

  // Replace lib/child_process.js exports.spawn / .exec / .execFile.
  // We're a post-patch on the public child_process module, so
  // \`module.exports\` IS the final cp object -- no circular require
  // dance required. exec(cmd, opts, cb) and execFile(file, args, opts, cb)
  // both produce ChildProcess and (for exec) a callback.
  var cp = module.exports;
  if (!cp || cp.__edgeAsyncReplaced) return;
  cp.__edgeAsyncReplaced = true;

  cp.spawn = function spawn(file, args, options) {
    // Normalize the same way lib does (file, args?, options?).
    if (Array.isArray(args)) {
      options = options || {};
    } else if (args != null && typeof args === 'object' && !Array.isArray(args)) {
      options = args;
      args = [];
    } else {
      args = args || [];
      options = options || {};
    }
    var fullArgs = [file].concat(args);
    return new EdgeChildProcess(file, fullArgs, options || {});
  };

  cp.execFile = function execFile(file, args, options, callback) {
    if (typeof args === 'function') { callback = args; args = []; options = {}; }
    else if (typeof options === 'function') { callback = options; options = {}; }
    args = args || [];
    options = options || {};
    var maxBuffer = (typeof options.maxBuffer === 'number' && options.maxBuffer > 0)
      ? options.maxBuffer : 1024 * 1024;
    var encoding = options.encoding || 'buffer';
    var child = cp.spawn(file, args, options);
    var stdoutChunks = [];
    var stderrChunks = [];
    var stdoutLen = 0;
    var stderrLen = 0;
    var errored = null;
    var settled = false;
    if (child.stdout) child.stdout.on('data', function(chunk) {
      if (errored) return;
      var c = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
      stdoutLen += c.length;
      if (stdoutLen > maxBuffer) {
        errored = new RangeError('stdout maxBuffer length exceeded');
        errored.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        try { child.kill(); } catch (e) { void e; }
        return;
      }
      stdoutChunks.push(c);
    });
    if (child.stderr) child.stderr.on('data', function(chunk) {
      if (errored) return;
      var c = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
      stderrLen += c.length;
      if (stderrLen > maxBuffer) {
        errored = new RangeError('stderr maxBuffer length exceeded');
        errored.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        try { child.kill(); } catch (e) { void e; }
        return;
      }
      stderrChunks.push(c);
    });
    function settle(err, code, sig) {
      if (settled) return;
      settled = true;
      var stdoutOut = Buffer.concat(stdoutChunks, stdoutLen);
      var stderrOut = Buffer.concat(stderrChunks, stderrLen);
      if (encoding && encoding !== 'buffer') {
        stdoutOut = stdoutOut.toString(encoding);
        stderrOut = stderrOut.toString(encoding);
      }
      if (errored && !err) err = errored;
      if (!err && (code !== 0 || sig != null)) {
        err = new Error('Command failed: ' + file + (args.length ? ' ' + args.join(' ') : ''));
        err.code = code;
        err.killed = sig != null;
        err.signal = sig;
        err.cmd = file + (args.length ? ' ' + args.join(' ') : '');
      }
      if (typeof callback === 'function') callback(err, stdoutOut, stderrOut);
    }
    child.on('error', function(err) { settle(err, null, null); });
    child.on('close', function(code, sig) { settle(null, code, sig); });
    return child;
  };

  cp.exec = function exec(command, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};
    // exec runs through a shell -- pass the full command to /bin/sh -c
    // (or the user's executor for the 'sh' command). Node uses
    // {shell: '/bin/sh', '-c', command} convention. For our model we
    // mirror that exactly so the executor can dispatch as it wishes.
    var shell = options.shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    var args = (process.platform === 'win32') ? ['/d', '/s', '/c', command] : ['-c', command];
    return cp.execFile(shell, args, options, callback);
  };
})();
`;

export const childProcessViaExecutor: Policy = {
  name: "child-process-via-executor",
  description:
    "Replace internalBinding('spawn_sync').spawn with a JS impl that delegates to a user-pluggable executor (default: small fake shell). Avoids the JSPI SuspendError from native spawn_sync's uv_run loop. Supports sync executors on the wasm worker (fast path) and async executors on the host worker (via sync RPC + Atomics.wait).",
  builtinOverrides: {
    "internal/child_process": { pre: PRE_PATCH, post: INTERNAL_POST_PATCH },
    "child_process": { post: PUBLIC_POST_PATCH },
  },
};
