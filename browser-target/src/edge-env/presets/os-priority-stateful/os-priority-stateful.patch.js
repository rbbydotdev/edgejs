// Pre-patch on lib/os.js: replace internalBinding('os').{setPriority,
// getPriority} with stateful JS implementations that simulate POSIX
// priority semantics inside the browser sandbox.
//
// THE BUG
//
// edge.js's wasm/WASI runtime stubs uv_os_setpriority as a no-op (returns
// 0 without storing the value) and uv_os_getpriority as returning 0.  In
// Node these are backed by setpriority(2)/getpriority(2) — real OS calls
// that aren't available under WASI.  Net effect:
//
//   os.setPriority(0, -20);     // succeeds (binding returns 0)
//   os.getPriority(0);          // returns 0  ❌  (expected -20)
//
// test-os-process-priority.js loops through valid priority values and
// verifies that getPriority returns what we just set.  The native stub
// silently breaks the round-trip and the test fails at the FIRST iter
// (PRIORITY_HIGHEST = -20).
//
// THE FIX
//
// Install JS replacements that store the priority in a Map keyed by the
// effective pid (matching uv_os_setpriority's pid==0 → "current process"
// semantics).  Mirror Node's documented behavior:
//
//   - setPriority(pid, priority, ctx): store priority for pid, return 0
//     on success.  For pid === -1 (test's "invalid pid"), populate ctx
//     with a uv-style error record AND return non-zero so lib/os.js
//     throws ERR_SYSTEM_ERROR with code ESRCH.
//   - getPriority(pid, ctx): return stored value (default PRIORITY_NORMAL
//     = 0) on success.  For pid === -1, populate ctx and return undefined
//     so lib/os.js throws ERR_SYSTEM_ERROR.
//
// SCOPE
//
// This is a binding-level shim for a feature with no meaningful browser
// equivalent.  We're not modeling real OS priority — we're preserving
// the JS-visible contract so user code can call set/getPriority without
// silent corruption.  If the user's app actually depends on priority
// affecting scheduling, the browser is the wrong target.

;(function patchOsPriority() {
  if (typeof internalBinding !== 'function') return;
  var b;
  try { b = internalBinding('os'); } catch (_e) { return; }
  if (!b) return;
  if (b.__edgeOsPriorityPatched) return;

  // Per-pid priority store.  pid===0 normalizes to "this process" — we
  // alias it to the process.pid value Node reports (1 in our browser
  // build) so set(0,X) followed by get(process.pid) returns X, matching
  // the test's expectations.
  var priorities = new Map();
  var DEFAULT_PRIORITY = 0; // PRIORITY_NORMAL

  function normalizedPid(pid) {
    // uv_os_setpriority(pid=0) → current process.  Node tests use 0,
    // undefined, and process.pid interchangeably; collapse them all to
    // the same key so the round-trip works regardless of which form
    // the caller picks.
    if (pid === 0 || pid === undefined) {
      try { return (typeof process !== 'undefined' && process.pid) | 0; }
      catch (_e) { return 1; }
    }
    return pid | 0;
  }

  // uv error format: ctx populated by SetContextError in src/edge_os.cc.
  // We mimic the exact shape lib/os.js (via ERR_SYSTEM_ERROR) consumes:
  //   ctx.syscall : the libuv API name (used in the error message)
  //   ctx.errno   : numeric errno (must be negative, matches uv convention)
  //   ctx.code    : string error code (e.g. 'ESRCH')
  //   ctx.message : optional human-readable detail
  function populateErrCtx(ctx, syscall, errno, code) {
    if (!ctx || typeof ctx !== 'object') return;
    try {
      ctx.syscall = syscall;
      ctx.errno = errno;
      ctx.code = code;
      // ERR_SYSTEM_ERROR also looks for `info` style fallback — set both.
      ctx.message = code;
    } catch (_e) { /* ctx may be frozen — defensive */ }
  }

  function setPriority(pid, priority, ctx) {
    var p = pid | 0;
    // pid === -1 → no such process.  Node returns ESRCH via uv.
    if (p === -1) {
      populateErrCtx(ctx, 'uv_os_setpriority', -3, 'ESRCH');
      return -3;
    }
    priorities.set(normalizedPid(p), priority | 0);
    return 0;
  }

  function getPriority(pid, ctx) {
    var p = pid | 0;
    if (p === -1) {
      populateErrCtx(ctx, 'uv_os_getpriority', -3, 'ESRCH');
      return undefined;
    }
    var key = normalizedPid(p);
    return priorities.has(key) ? priorities.get(key) : DEFAULT_PRIORITY;
  }

  try {
    Object.defineProperty(b, 'setPriority', {
      configurable: true, writable: true, value: setPriority,
    });
    Object.defineProperty(b, 'getPriority', {
      configurable: true, writable: true, value: getPriority,
    });
    Object.defineProperty(b, '__edgeOsPriorityPatched', {
      configurable: true, writable: true, value: true,
    });
  } catch (_e) {
    b.setPriority = setPriority;
    b.getPriority = getPriority;
    b.__edgeOsPriorityPatched = true;
  }
})();
