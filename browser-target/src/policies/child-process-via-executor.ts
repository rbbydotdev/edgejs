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

  // Resolve the host-installed executor at first call (not at policy
  // load) so the deployment can install it AFTER the prelude is wired
  // -- e.g. in a setTimeout or after the wasm boots.
  function resolveExecutor() {
    var g = (typeof globalThis !== 'undefined' && globalThis) ||
            (typeof global !== 'undefined' && global);
    var ex = g && g.__edgeChildProcessExecutor;
    if (typeof ex === 'function') return ex;
    return defaultEchoExecutor;
  }

  // Default executor: echoes the command + args back to stdout. Just
  // enough for "the intercept is wired and routes through this layer".
  function defaultEchoExecutor(command, args, _opts) {
    var line = String(command);
    if (args && args.length > 0) line += ' ' + args.join(' ');
    return {
      stdout: line + '\\n',
      stderr: '',
      code: 0,
      signal: null,
      error: null,
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
    if (execResult.error) {
      var err = new Error(execResult.error.message || 'spawn error');
      err.code = execResult.error.code || 'ESPAWN';
      err.errno = 0;
      result.error = err;
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
    var executor = resolveExecutor();
    var execResult;
    try {
      execResult = executor(command, args, {
        env: env,
        cwd: options.cwd != null ? String(options.cwd) : undefined,
        input: input,
        timeout: typeof options.timeout === 'number' ? options.timeout : undefined,
      });
    } catch (e) {
      // Executor itself threw -- surface as a spawn error.
      var sysErr = new Error(e && e.message ? e.message : String(e));
      sysErr.code = (e && e.code) || 'ESPAWN_EXECUTOR';
      return {
        pid: 0,
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: null,
        error: sysErr,
      };
    }
    // Detect accidentally-async executors so users get a clear message.
    if (execResult && typeof execResult.then === 'function') {
      var asyncErr = new Error(
        'edgejs child-process executor returned a Promise; MVP only supports sync return',
      );
      asyncErr.code = 'ERR_NOT_IMPLEMENTED';
      return {
        pid: 0,
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: null,
        error: asyncErr,
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
