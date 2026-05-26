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
// ARCHITECTURE (P3.5+)
//
// Two patch sites on `internal/child_process`:
//
//   1. PRE_PATCH installs four binding shims BEFORE lib's body runs:
//      - `spawn_sync.spawn`: sync executor (JSPI-safe; the rest of
//        this file)
//      - `stream_wrap`: streamBaseState typed array + indices +
//        WriteWrap class (required by stream_base_commons.js)
//      - `pipe_wrap.Pipe` + `.constants`: our EdgePipe class satisfies
//        net.Socket({handle, ...}) AND setupChannel(ipcPipe) (json mode)
//      - `process_wrap.Process`: our EdgeProcess class is what lib's
//        ChildProcess wraps. lib does ALL the user-facing surface
//        (.ref/.unref, .spawnfile, .spawnargs, .stdio[], setupChannel
//        for IPC, getValidStdio for stdio normalization, ...).
//
//   2. INTERNAL_POST_PATCH wraps spawnSync so our __edgeError marker
//      becomes a proper Error with the right code (sidesteps the
//      build-specific libuv error-number mapping).
//
// What lib drives natively (we removed our wholesale spawn/exec/execFile/
// fork override; lib's exports work because the bindings underneath are
// our shims):
//   - ref() / unref(): lib delegates to handle.ref()/unref()
//   - shell:true wrapping in /bin/sh -c (lib's normalizeSpawnArguments)
//   - argv0, detached, uid, gid (lib reads them; we accept silently)
//   - spawnfile / spawnargs (lib sets on ChildProcess)
//   - child.stdio[] composite array (lib builds it)
//   - stdio[3+] extra pipes (lib's getValidStdio creates per-fd Pipes;
//     each is bound by EdgeProcess.spawn and routes through our
//     OP_SPAWN_STDIO_WRITE / kind=7 events)
//   - stdio[N] as Stream / fd-number (lib's getValidStdio handles the
//     wrap/fd types)
//   - IPC channel (lib's setupChannel handles framing + serialization;
//     we just transport bytes through Pipe.writeUtf8String + onread)
//   - cp.fork() (lib's native fork → cp.spawn → ChildProcess → us)
//
// REMAINING DEBT
//
// - `#!~debt child-process-ipc-sendhandle`: sendHandle (passing fds/
//   sockets/servers via .send) is silently dropped. Real Node uses
//   kernel fd-passing; we have no equivalent. cluster.js needs this.
// - `#!~debt child-process-ipc-advanced-serialization`: serialization
//   mode 'advanced' (v8 structured-clone) currently degrades to json.
//   See P3.7 for the structured-clone-over-postMessage upgrade path.
// - `#!~debt child-process-kill-cooperation`: kill() fires an
//   AbortSignal that the executor must poll. Real Node interrupts the
//   syscall the child is in -- impossible without a real OS process.
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

// =====================================================================
// P3.5: process_wrap, pipe_wrap, stream_wrap binding shims.
//
// Replaces the wholesale cp.spawn/exec/execFile/fork overrides with
// binding-level intercepts so lib's native ChildProcess (and getValidStdio,
// setupChannel, ref/unref, spawnfile/spawnargs, child.stdio[] array,
// shell:true, argv0, detached/uid/gid pass-through) ALL work as Node
// intends. The host-worker executor RPC underneath is unchanged.
// =====================================================================
(function installAsyncSpawnBindingShims() {
  function getG() {
    return (typeof globalThis !== 'undefined' && globalThis) ||
           (typeof global !== 'undefined' && global);
  }
  var g = getG();

  // --- stream_wrap shim (provides streamBaseState typed array + indices) ---
  var streamWrapBinding;
  try { streamWrapBinding = internalBinding('stream_wrap'); } catch (_e) { void _e; }
  if (!streamWrapBinding) return;
  // Edge.js already populates stream_wrap with streamBaseState (Int32Array
  // over a SAB-backed ArrayBuffer), kReadBytesOrError/etc. indices, and
  // WriteWrap/ShutdownWrap constructors. We MUST NOT replace these --
  // some lib modules (notably internal/stream_base_commons via net.js)
  // destructure them at module-load time, and edge's bootstrap order
  // means those modules may load BEFORE our PRE_PATCH fires. Replacing
  // the instance leaves those modules holding edge's original, while
  // OUR Pipe writes to a different one. Just READ what edge provides
  // and use it directly.
  var streamBaseState = streamWrapBinding.streamBaseState;
  var kReadBytesOrError = (typeof streamWrapBinding.kReadBytesOrError === 'number') ? streamWrapBinding.kReadBytesOrError : 0;
  var kArrayBufferOffset = (typeof streamWrapBinding.kArrayBufferOffset === 'number') ? streamWrapBinding.kArrayBufferOffset : 1;
  var kBytesWritten = (typeof streamWrapBinding.kBytesWritten === 'number') ? streamWrapBinding.kBytesWritten : 2;
  var kLastWriteWasAsync = (typeof streamWrapBinding.kLastWriteWasAsync === 'number') ? streamWrapBinding.kLastWriteWasAsync : 3;
  // Sanity: if streamBaseState is missing entirely (older edge build),
  // install a fallback. Otherwise edge's array is the canonical one.
  if (!streamBaseState) {
    streamBaseState = new Int32Array(4);
    streamWrapBinding.streamBaseState = streamBaseState;
    streamWrapBinding.kReadBytesOrError = kReadBytesOrError;
    streamWrapBinding.kArrayBufferOffset = kArrayBufferOffset;
    streamWrapBinding.kBytesWritten = kBytesWritten;
    streamWrapBinding.kLastWriteWasAsync = kLastWriteWasAsync;
  }
  if (typeof streamWrapBinding.WriteWrap !== 'function') {
    streamWrapBinding.WriteWrap = function WriteWrap() {};
  }
  if (typeof streamWrapBinding.ShutdownWrap !== 'function') {
    streamWrapBinding.ShutdownWrap = function ShutdownWrap() {};
  }

  // --- Per-child Process map + event buffer (race-safe handoff) ---
  var processesByChildId = new Map();
  var pendingEventBuffer = new Map();

  g.__edgeChildProcessAsyncEvent = function(childId, kind, payload) {
    var proc = processesByChildId.get(childId);
    if (proc) { proc._handleEvent(kind, payload); return; }
    var buf = pendingEventBuffer.get(childId);
    if (!buf) { buf = []; pendingEventBuffer.set(childId, buf); }
    buf.push([kind, payload]);
  };
  function registerProcess(childId, proc) {
    processesByChildId.set(childId, proc);
    var buffered = pendingEventBuffer.get(childId);
    if (buffered) {
      pendingEventBuffer.delete(childId);
      for (var i = 0; i < buffered.length; i++) {
        proc._handleEvent(buffered[i][0], buffered[i][1]);
      }
    }
  }
  function deregisterProcess(childId) { processesByChildId.delete(childId); }

  // --- Loop keepalive: refed setInterval, ref-counted per pinned handle ---
  var keepaliveTimer = null;
  var keepaliveRefCount = 0;
  function keepaliveAcquire() {
    keepaliveRefCount++;
    if (keepaliveTimer == null) keepaliveTimer = setInterval(function() {}, 50);
  }
  function keepaliveRelease() {
    if (keepaliveRefCount > 0) keepaliveRefCount--;
    if (keepaliveRefCount === 0 && keepaliveTimer != null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  var nextAsyncId = 1;
  // Read UV errno constants from edge.js's binding so they match what
  // lib's UV_* constants resolve to. Our wasi-libc-based env has DIFFERENT
  // numeric values than canonical libuv (e.g. UV_ENOENT is -44 here, not
  // -2 -- because util.getSystemErrorName needs that mapping to produce
  // 'ENOENT'). Hardcoding the canonical libuv numbers makes lib's onexit
  // fire 'error' with the WRONG err.code string.
  var uvBinding = {};
  try { uvBinding = internalBinding('uv'); } catch (_e) { void _e; }
  var UV_EOF = (typeof uvBinding.UV_EOF === 'number') ? uvBinding.UV_EOF : -4095;
  var UV_EPIPE = (typeof uvBinding.UV_EPIPE === 'number') ? uvBinding.UV_EPIPE : -32;
  var UV_ENOSYS = (typeof uvBinding.UV_ENOSYS === 'number') ? uvBinding.UV_ENOSYS : -38;
  var UV_ENOENT = (typeof uvBinding.UV_ENOENT === 'number') ? uvBinding.UV_ENOENT : -2;
  var UV_ESRCH = (typeof uvBinding.UV_ESRCH === 'number') ? uvBinding.UV_ESRCH : -3;
  var UV_EINVAL = (typeof uvBinding.UV_EINVAL === 'number') ? uvBinding.UV_EINVAL : -22;

  // --- EdgePipe: shim for internalBinding('pipe_wrap').Pipe.
  // Satisfies net.Socket({handle, ...}) and lib's setupChannel(ipc).
  // For type=SOCKET, lib wraps us in net.Socket; for IPC, lib reads
  // bytes via onread (json-deframed by serialization.js).
  function EdgePipe(type) {
    this._type = type;
    this._isIpc = type === 2;
    this._closed = false;
    this._reading = false;
    this.reading = false;
    this._asyncId = nextAsyncId++;
    this._bufferedReads = [];
    this.onread = null;
    this.pendingHandle = null;
    this.buffering = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._childId = null;
    this._fdIndex = -1;
    this._refed = true;
    this._endedRead = false;
  }
  EdgePipe.prototype.getAsyncId = function() { return this._asyncId; };
  EdgePipe.prototype.ref = function() {
    if (!this._refed) { this._refed = true; keepaliveAcquire(); }
  };
  EdgePipe.prototype.unref = function() {
    if (this._refed) { this._refed = false; keepaliveRelease(); }
  };
  EdgePipe.prototype.readStart = function() {
    this._reading = true;
    this.reading = true;
    while (this._bufferedReads.length > 0 && this._reading) {
      this._deliverReadNow(this._bufferedReads.shift());
    }
    if (this._endedRead && this._reading) this._deliverEof();
    return 0;
  };
  EdgePipe.prototype.readStop = function() {
    this._reading = false;
    this.reading = false;
    return 0;
  };
  EdgePipe.prototype._deliverRead = function(bytes) {
    if (!this._reading || !this.onread) {
      this._bufferedReads.push(bytes);
      return;
    }
    this._deliverReadNow(bytes);
  };
  EdgePipe.prototype._deliverReadNow = function(bytes) {
    this.bytesRead += bytes.byteLength;
    streamBaseState[kReadBytesOrError] = bytes.byteLength;
    streamBaseState[kArrayBufferOffset] = bytes.byteOffset;
    this.onread(bytes.buffer);
  };
  EdgePipe.prototype._deliverEof = function() {
    if (!this.onread) return;
    streamBaseState[kReadBytesOrError] = UV_EOF;
    streamBaseState[kArrayBufferOffset] = 0;
    this.onread(undefined);
  };
  EdgePipe.prototype._endRead = function() {
    if (this._endedRead) return;
    this._endedRead = true;
    if (this._reading) this._deliverEof();
  };
  EdgePipe.prototype._writeBytes = function(_req, buf) {
    if (this._closed || this._childId == null) {
      streamBaseState[kBytesWritten] = 0;
      streamBaseState[kLastWriteWasAsync] = 0;
      return UV_EPIPE;
    }
    if (this._isIpc) {
      // IPC: forward raw bytes (lib already framed as "JSON\\n"). Host
      // accumulates, splits on \\n, parses, calls executor.opts.ipc.on('message').
      var ipcSend = g.__edgeChildProcessIpcSend;
      if (typeof ipcSend !== 'function') return UV_EPIPE;
      var asString = '';
      // Decode buf bytes to UTF-8 string for the existing IPC RPC shape
      // (legacy: takes a JSON string). Host will detect framing.
      try { asString = new TextDecoder('utf-8').decode(buf); }
      catch (e) { void e; return UV_EPIPE; }
      var status = ipcSend(this._childId, asString);
      if (status !== 0) return UV_EPIPE;
      this.bytesWritten += buf.length;
      streamBaseState[kBytesWritten] = buf.length;
      streamBaseState[kLastWriteWasAsync] = 0;
      return 0;
    }
    var writer = g.__edgeChildProcessStdioWrite;
    if (typeof writer !== 'function') return UV_EPIPE;
    var st = writer(this._childId, this._fdIndex, buf);
    if (st !== 0) return UV_EPIPE;
    this.bytesWritten += buf.length;
    streamBaseState[kBytesWritten] = buf.length;
    streamBaseState[kLastWriteWasAsync] = 0;
    return 0;
  };
  EdgePipe.prototype.writev = function(req, chunks, allBuffers) {
    var collected = [];
    var total = 0;
    if (allBuffers) {
      for (var i = 0; i < chunks.length; i++) {
        collected.push(chunks[i]);
        total += chunks[i].length;
      }
    } else {
      for (var j = 0; j < chunks.length; j += 2) {
        var chunk = chunks[j];
        var enc = chunks[j + 1];
        var b = Buffer.isBuffer(chunk) ? chunk
          : (typeof chunk === 'string' ? Buffer.from(chunk, enc || 'utf8')
              : Buffer.from(chunk));
        collected.push(b);
        total += b.length;
      }
    }
    return this._writeBytes(req, Buffer.concat(collected, total));
  };
  EdgePipe.prototype.writeBuffer = function(req, buf) { return this._writeBytes(req, buf); };
  EdgePipe.prototype.writeUtf8String = function(req, str) { return this._writeBytes(req, Buffer.from(String(str), 'utf8')); };
  EdgePipe.prototype.writeAsciiString = function(req, str) { return this._writeBytes(req, Buffer.from(String(str), 'ascii')); };
  EdgePipe.prototype.writeLatin1String = function(req, str) { return this._writeBytes(req, Buffer.from(String(str), 'latin1')); };
  EdgePipe.prototype.writeUcs2String = function(req, str) { return this._writeBytes(req, Buffer.from(String(str), 'ucs2')); };
  EdgePipe.prototype.shutdown = function(req) {
    if (this._childId == null) return UV_EPIPE;
    if (this._isIpc) {
      var d = g.__edgeChildProcessIpcDisconnect;
      if (typeof d === 'function') d(this._childId);
    } else {
      var e = g.__edgeChildProcessStdioEnd;
      if (typeof e === 'function') e(this._childId, this._fdIndex);
    }
    process.nextTick(function() {
      if (req && typeof req.oncomplete === 'function') req.oncomplete(0);
    });
    return 0;
  };
  EdgePipe.prototype.close = function(cb) {
    if (this._closed) { if (cb) process.nextTick(cb); return; }
    this._closed = true;
    if (this._refed) { this._refed = false; keepaliveRelease(); }
    if (cb) process.nextTick(cb);
  };
  EdgePipe.prototype.setNoDelay = function() {};
  EdgePipe.prototype.setKeepAlive = function() {};

  // --- EdgeProcess: shim for internalBinding('process_wrap').Process.
  // Drives the async-spawn host RPC. Lib's ChildProcess wraps us and
  // provides all the user-facing semantics (ref/unref, .pid, .stdio[],
  // .spawnfile, .spawnargs, IPC channel via setupChannel, ...).
  function EdgeProcess() {
    this._closed = false;
    this._childId = null;
    this.pid = 0;
    this.onexit = null;
    this._stdioPipes = [];
    this._ipcPipe = null;
    this._refed = true;
    this._exited = false;
  }
  EdgeProcess.prototype.spawn = function(options) {
    var startAsync = g.__edgeChildProcessSpawnAsync;
    if (typeof startAsync !== 'function') return UV_ENOSYS;
    var stdio = options.stdio || [];
    var hasIpc = false;
    for (var i = 0; i < stdio.length; i++) {
      var entry = stdio[i];
      if (entry && entry.handle && entry.handle instanceof EdgePipe) {
        entry.handle._fdIndex = i;
        this._stdioPipes[i] = entry.handle;
        if (entry.ipc || entry.handle._isIpc) {
          hasIpc = true;
          this._ipcPipe = entry.handle;
        }
      }
    }
    var envMap;
    if (Array.isArray(options.envPairs)) {
      envMap = {};
      for (var k = 0; k < options.envPairs.length; k++) {
        var kv = String(options.envPairs[k]);
        var eq = kv.indexOf('=');
        if (eq > 0) envMap[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }
    var headerObj = {
      command: String(options.file || ''),
      // options.args is the FULL argv (file is args[0]). Slice to get user args.
      args: Array.isArray(options.args) ? options.args.slice(1).map(String) : [],
      env: envMap,
      cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
      ipc: hasIpc,
    };
    var headerBytes = new TextEncoder().encode(JSON.stringify(headerObj));
    var reqBuf = new Uint8Array(4 + headerBytes.byteLength + 4);
    var dv = new DataView(reqBuf.buffer);
    dv.setUint32(0, headerBytes.byteLength, true);
    reqBuf.set(headerBytes, 4);
    dv.setUint32(4 + headerBytes.byteLength, 0, true);

    var started = startAsync(reqBuf);
    if (started.status !== 0) {
      // started.status is our protocol's own value (negative libuv-style
      // but using OUR shim's negative numbers, not edge's env's). Just
      // map "spawn rejected" cases to ENOENT, anything else to EINVAL.
      return started.status === -2 ? UV_ENOENT : UV_EINVAL;
    }
    this._childId = started.childId;
    this.pid = started.childId;
    for (var n = 0; n < this._stdioPipes.length; n++) {
      var p = this._stdioPipes[n];
      if (p) p._childId = this._childId;
    }
    keepaliveAcquire();
    registerProcess(this._childId, this);
    return 0;
  };
  EdgeProcess.prototype._handleEvent = function(kind, payload) {
    if (this._exited) return;
    if (kind === 4 /*spawned*/) return; // pid already set in spawn()
    if (kind === 0 /*stdout*/) {
      var so = this._stdioPipes[1];
      if (so) so._deliverRead(payload);
      return;
    }
    if (kind === 1 /*stderr*/) {
      var se = this._stdioPipes[2];
      if (se) se._deliverRead(payload);
      return;
    }
    if (kind === 5 /*ipc-message*/) {
      if (!this._ipcPipe) return;
      // Host emits JSON (no newline). Lib's json deframer splits on \\n,
      // so we append one. parseChannelMessages then JSON.parses cleanly.
      var withNl = new Uint8Array(payload.byteLength + 1);
      withNl.set(payload, 0);
      withNl[payload.byteLength] = 0x0A;
      this._ipcPipe._deliverRead(withNl);
      return;
    }
    if (kind === 6 /*ipc-disconnect*/) {
      if (this._ipcPipe) this._ipcPipe._endRead();
      return;
    }
    if (kind === 7 /*stdio-fdN*/) {
      if (payload.byteLength < 4) return;
      var dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      var fdIdx = dv.getUint32(0, true);
      var bytes = payload.subarray(4);
      var pipe = this._stdioPipes[fdIdx];
      if (pipe) {
        if (bytes.byteLength === 0) pipe._endRead();
        else pipe._deliverRead(bytes);
      }
      return;
    }
    if (kind === 3 /*error*/) {
      // Spawn-time error: lib treats negative exitCode in onexit as the
      // spawn-failure error path (emits 'error' event with ErrnoException).
      // Also EOF all read-side pipes so the wrapping net.Sockets close
      // and lib's maybeClose() can fire 'close' on the ChildProcess.
      for (var i3 = 0; i3 < this._stdioPipes.length; i3++) {
        var sp3 = this._stdioPipes[i3];
        if (sp3 && i3 !== 0) sp3._endRead();
      }
      this._exited = true;
      if (this.onexit) this.onexit(UV_ENOENT, null);
      if (this._refed) { this._refed = false; keepaliveRelease(); }
      deregisterProcess(this._childId);
      return;
    }
    if (kind === 2 /*exit*/) {
      var dv2 = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      var codeRaw = dv2.getInt32(0, true);
      var sigLen = dv2.getUint32(4, true);
      var sig = sigLen > 0
        ? new TextDecoder().decode(payload.subarray(8, 8 + sigLen))
        : null;
      var code = (codeRaw === -1 && sig != null) ? 0 : codeRaw;
      // EOF on all read-side pipes (stdout, stderr, extras, IPC).
      for (var i2 = 0; i2 < this._stdioPipes.length; i2++) {
        var sp = this._stdioPipes[i2];
        if (sp && i2 !== 0) sp._endRead();
      }
      this._exited = true;
      if (this.onexit) this.onexit(code, sig);
      if (this._refed) { this._refed = false; keepaliveRelease(); }
      deregisterProcess(this._childId);
      return;
    }
  };
  EdgeProcess.prototype.kill = function(signal) {
    if (this._childId == null) return UV_ESRCH;
    var killer = g.__edgeChildProcessKillAsync;
    if (typeof killer !== 'function') return 0; // best-effort; no-op
    // Map numeric signal to name for our host RPC. Lib gives us numeric
    // signal (via convertToValidSignal). Our host expects a string.
    var SIG_NUM_TO_NAME = {
      1:'SIGHUP', 2:'SIGINT', 3:'SIGQUIT', 4:'SIGILL', 5:'SIGTRAP',
      6:'SIGABRT', 7:'SIGBUS', 8:'SIGFPE', 9:'SIGKILL', 10:'SIGUSR1',
      11:'SIGSEGV', 12:'SIGUSR2', 13:'SIGPIPE', 14:'SIGALRM', 15:'SIGTERM',
      17:'SIGCHLD', 18:'SIGCONT', 19:'SIGSTOP', 20:'SIGTSTP',
    };
    var sigName;
    if (signal === 0) sigName = '0'; // signal 0 == "is alive?" probe
    else if (typeof signal === 'number') sigName = SIG_NUM_TO_NAME[signal] || ('SIG' + signal);
    else sigName = signal || 'SIGTERM';
    try { killer(this._childId, String(sigName)); } catch (e) { void e; }
    // Always return 0 so lib doesn't throw or emit 'error'. Our executor
    // may not honor the signal (no real OS process), but the kill API
    // contract returns "delivered successfully to the kernel" -- which
    // for us means "the abort signal was forwarded to the executor."
    return 0;
  };
  EdgeProcess.prototype.close = function() { this._closed = true; };
  EdgeProcess.prototype.ref = function() {
    if (!this._refed) { this._refed = true; keepaliveAcquire(); }
  };
  EdgeProcess.prototype.unref = function() {
    if (this._refed) { this._refed = false; keepaliveRelease(); }
  };

  // --- Install bindings (idempotent) ---
  var pipeWrapBinding;
  try { pipeWrapBinding = internalBinding('pipe_wrap'); } catch (_e) { void _e; }
  if (pipeWrapBinding && !pipeWrapBinding.__edgePipeInstalled) {
    pipeWrapBinding.__edgePipeInstalled = true;
    pipeWrapBinding.constants = { SOCKET: 0, SERVER: 1, IPC: 2, UV_READABLE: 1, UV_WRITABLE: 2 };
    pipeWrapBinding.Pipe = EdgePipe;
    pipeWrapBinding.PipeConnectWrap = function PipeConnectWrap() {};
  }
  var processWrapBinding;
  try { processWrapBinding = internalBinding('process_wrap'); } catch (_e) { void _e; }
  if (processWrapBinding && !processWrapBinding.__edgeProcessInstalled) {
    processWrapBinding.__edgeProcessInstalled = true;
    processWrapBinding.Process = EdgeProcess;
  }

  // --- serdes binding stub: lib/v8.js destructures Serializer/Deserializer
  // from internalBinding('serdes'). When IPC setupChannel triggers a require
  // of lib's serialization.js (which requires v8), v8.js tries to do
  // \`class DefaultSerializer extends Serializer\` -- if Serializer is
  // undefined we get "Cannot read properties of undefined (reading 'prototype')".
  // Stub Serializer/Deserializer here so v8.js loads. Only matters for
  // serialization mode 'advanced' -- json mode (our default) never uses
  // these. #!~debt child-process-ipc-advanced-serialization tracked. ---
  var serdesBinding;
  try { serdesBinding = internalBinding('serdes'); } catch (_e) { void _e; }
  if (serdesBinding && typeof serdesBinding.Serializer !== 'function') {
    function StubSerializer() {
      this._buf = [];
    }
    StubSerializer.prototype._writeHostObject = function() {};
    StubSerializer.prototype.writeHeader = function() {};
    StubSerializer.prototype.writeValue = function(v) { this._buf.push(v); };
    StubSerializer.prototype.writeUint32 = function() {};
    StubSerializer.prototype.writeRawBytes = function() {};
    StubSerializer.prototype.releaseBuffer = function() { return Buffer.alloc(0); };
    StubSerializer.prototype.transferArrayBuffer = function() {};
    function StubDeserializer(_buf) {}
    StubDeserializer.prototype._readHostObject = function() { return undefined; };
    StubDeserializer.prototype.readHeader = function() {};
    StubDeserializer.prototype.readValue = function() { return undefined; };
    StubDeserializer.prototype.readUint32 = function() { return 0; };
    StubDeserializer.prototype.transferArrayBuffer = function() {};
    serdesBinding.Serializer = StubSerializer;
    serdesBinding.Deserializer = StubDeserializer;
  }
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


export const childProcessViaExecutor: Policy = {
  name: "child-process-via-executor",
  description:
    "Intercepts the spawn_sync, process_wrap, pipe_wrap, and stream_wrap bindings so lib's native ChildProcess / setupChannel / getValidStdio drive the surface (ref/unref, spawnfile, child.stdio[], IPC, shell:true, argv0, ...) while a user-pluggable executor handles the actual work. Avoids the JSPI SuspendError from native spawn_sync's uv_run loop.",
  builtinOverrides: {
    "internal/child_process": { pre: PRE_PATCH, post: INTERNAL_POST_PATCH },
  },
};
