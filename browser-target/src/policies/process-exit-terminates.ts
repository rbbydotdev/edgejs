import type { Policy } from "./index";

// process-exit-terminates: make `process.exit()` actually halt user-script
// execution.
//
// THE BUG
//
// In Node, `process.exit()` calls `process.reallyExit()` which invokes
// `Isolate::TerminateExecution()` — that flips a V8 flag so the next stack
// guard check throws a non-catchable termination exception, unwinding the
// JS stack out of user code.  In our wasm build there is no V8 termination
// path: `process.reallyExit` is implemented by the wasm binding, which
// calls our `unofficial_napi_terminate_execution` import.  That import
// sets `exitState.requested = true` in the wasi-shim so a parked
// `poll_oneoff` can wake — but it doesn't throw.  The wasm returns from
// `reallyExit`, JS-side `process.exit` returns, and user code continues
// past the exit call as if nothing happened.
//
// SURFACES IN THE CORPUS as:
//   - Tests that `common.skip()` (which calls `process.exit(0)`) — the
//     skip line prints but execution continues, then later code crashes
//     and the test is marked FAIL instead of skipped/passed.  Example:
//     test-buffer-alloc-unsafe-is-{uninitialized,initialized-with-zero-fill-flag}.js
//     where the test self-skips because we're not a debug build, then
//     hits a destructure of an undefined `internalBinding('debug')`.
//   - Any user code that uses `process.exit` for early-return semantics.
//
// THE FIX (this policy)
//
// Post-patch `internal/process/per_thread.js` to wrap the `exit` function
// returned by `wrapProcessMethods`.  After the original `exit` calls
// `reallyExit` (which signals wasm-side exit), throw an `ExitSignal`-
// shaped error so the JS stack unwinds out of user code.
//
// The catch in `unofficial_napi_contextify_run_script` (napi-host/unofficial.ts)
// recognizes the sentinel — duck-typed via `err.name === 'ExitSignal' &&
// err.__edgeExitSignal === true` — and returns success rather than
// surfacing it as a script error.  The wasm-side exit flag has already
// been set, so subsequent wasm activity (next poll_oneoff, finalizer
// drain) will honor the exit normally.
//
// HONESTY NOTE
//
// This matches Node's real behavior — `process.exit()` is supposed to be
// terminal.  Without this, our `process.exit` silently returns and user
// code keeps running, which is the actual Node-compat bug.

const POST_PATCH = `
;(function applyProcessExitTerminates() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var origWrap = module.exports.wrapProcessMethods;
  if (typeof origWrap !== 'function') return;
  if (origWrap.__edgeExitTerminatesPatched) return;

  function wrapProcessMethodsExitPatched(binding) {
    var result = origWrap(binding);
    if (!result || typeof result.exit !== 'function') return result;
    var origExit = result.exit;
    if (origExit.__edgeExitTerminatesPatched) return result;

    function exit(code) {
      // Run the original exit — this sets process.exitCode, emits the
      // 'exit' event, and calls reallyExit which signals the wasm-side
      // exit-requested flag via unofficial_napi_terminate_execution.
      try { origExit.call(this, code); } catch (e) {
        // If the original exit somehow threw, propagate as-is — don't
        // wrap it in our sentinel and lose the diagnostic.
        throw e;
      }
      // In real Node, control never returns to here — V8 TerminateExecution
      // would have unwound the stack.  In wasm we have to do that work
      // ourselves: throw a sentinel the run_script catch will recognize
      // and treat as a clean exit (NOT as a script error).
      var err = new Error('ExitSignal');
      err.name = 'ExitSignal';
      err.code = typeof code === 'number' ? (code >>> 0)
               : (typeof process !== 'undefined' && typeof process.exitCode === 'number' ? (process.exitCode >>> 0) : 0);
      err.__edgeExitSignal = true;
      throw err;
    }
    exit.__edgeExitTerminatesPatched = true;
    result.exit = exit;
    return result;
  }
  wrapProcessMethodsExitPatched.__edgeExitTerminatesPatched = true;
  module.exports.wrapProcessMethods = wrapProcessMethodsExitPatched;
})();
`;

export const processExitTerminates: Policy = {
  name: "process-exit-terminates",
  description:
    "Make process.exit() actually unwind user-script execution. Our wasm build has no V8 TerminateExecution path, so without this patch process.exit() silently returns and user code keeps running. Composes additively with process-methods-wasm-state on the same module — the framework concatenates {post} patches in declaration order.",
  builtinOverrides: {
    "internal/process/per_thread": { post: POST_PATCH },
  },
};
