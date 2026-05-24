import type { Policy } from "./index";

// E20: Four `process.*` APIs in lib/internal/process/per_thread.js exhibit
// the same JS-heap typed-array staleness bug E13/E15 documented for zlib:
//
//   line 123  const cpuValues      = new Float64Array(2);   // process.cpuUsage
//   line 163  const threadCpuValues= new Float64Array(2);   // process.threadCpuUsage
//   line 215  const memValues      = new Float64Array(5);   // process.memoryUsage
//   line 329  const resourceValues = new Float64Array(16);  // process.resourceUsage
//
// The C++ binding (`binding.cpuUsage(cpuValues)` etc.) writes through the
// typed array's wasm-memory pointer.  The host's
// `napi_get_typedarray_info` override syncs wasm→JS BEFORE the C++ write,
// so JS sees state ONE call behind wasm.  Silent failure: each call
// returns the previous call's values (zeros on the first call).  See
// experiments/e19-staleness-audit/FINDINGS.md.
//
// FIX SHAPE
//
// The 4 `Float64Array`s are closure-private inside the
// `wrapProcessMethods(binding)` function, so we can't reach them from a
// `{post}` patch directly.  Instead we wrap the exported
// `wrapProcessMethods` so that AFTER the original runs, the four returned
// methods (`cpuUsage`, `threadCpuUsage`, `memoryUsage`, `resourceUsage`)
// are REPLACED with versions that:
//   1. Allocate a wasm-backed Float64Array of the same length via
//      `internalBinding('buffer').createUnsafeArrayBuffer(N * 8)`.
//   2. Call the same C++ binding method directly with the wasm-backed
//      view as the destination.
//   3. Read result fields from the wasm-backed view (now fresh, since JS
//      and wasm share the SAB-backed bytes).
//
// The replacement methods preserve the exact public-API shape Node
// documents (arg validation, prevValue diffs, sunos refusal).
//
// COMPOSITION
//
// Depends on `buffer-wasm-aliased`: without it,
// `createUnsafeArrayBuffer` returns a plain ArrayBuffer (no wasm-aliased
// view) and the fix degrades to a no-op (we detect the fallback and skip
// the swap, leaving the buggy-but-functional originals in place).
//
// DEFAULT-VS-OPT-IN
//
// SHIPPED IN `minimalPolicies` (and therefore `defaultBrowserPolicies`)
// because these are silent correctness bugs in widely-used public APIs.
// `process.cpuUsage()`, `process.memoryUsage()` etc. are commonly used by
// monitoring/telemetry/health-check code where "wrong by one call" is a
// real product bug — and the failure mode produces zero error signal.
// The patch surface is tiny (4 method replacements) and behaviorally
// transparent: if `buffer-wasm-aliased` isn't active, we no-op rather
// than break.  The risk profile matches zlib-writestate-wasm, which is
// also in `minimalPolicies`.

const POST_PATCH = `
;(function applyProcessMethodsWasmState() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var origWrap = module.exports.wrapProcessMethods;
  if (typeof origWrap !== 'function') return;

  var bufBinding;
  try { bufBinding = internalBinding('buffer'); } catch (_e) { return; }
  var cuab = bufBinding && bufBinding.createUnsafeArrayBuffer;
  if (typeof cuab !== 'function') return;

  // Allocate a wasm-backed Float64Array(N) — works only when
  // \`buffer-wasm-aliased\` is active (then \`createUnsafeArrayBuffer\`
  // returns a Uint8Array VIEW over wasm memory; we re-view as Float64).
  function makeWasmFloat64(n) {
    var u8;
    try { u8 = cuab(n * 8); } catch (_e) { return null; }
    if (!u8 || !ArrayBuffer.isView(u8)) return null;
    // Zero the bytes — original was \`new Float64Array(N)\` which is zeroed.
    new Uint8Array(u8.buffer, u8.byteOffset, n * 8).fill(0);
    return new Float64Array(u8.buffer, u8.byteOffset, n);
  }

  // Mirror per_thread.js's small validator (private to that module).
  // Inlining here is cheaper than re-importing and keeps the wrapper
  // self-contained.
  function previousValueIsValid(num) {
    return typeof num === 'number' &&
        num <= Number.MAX_SAFE_INTEGER &&
        num >= 0;
  }

  // ERR_* code lookups: we throw the same TypeError shapes Node does,
  // but we don't go through internal/errors (avoiding a circular load
  // at bootstrap time).  Node's error codes are stable strings, so
  // attaching .code on a plain TypeError matches consumer code that
  // checks \`err.code === 'ERR_INVALID_ARG_VALUE'\`.
  function mkErr(code, msg) {
    var e = new RangeError(msg);
    e.code = code;
    return e;
  }

  module.exports.wrapProcessMethods = function wrapProcessMethodsPatched(binding) {
    var result = origWrap(binding);
    if (!result || typeof result !== 'object') return result;

    var cpuValues = makeWasmFloat64(2);
    var threadCpuValues = makeWasmFloat64(2);
    var memValues = makeWasmFloat64(5);
    var resourceValues = makeWasmFloat64(16);
    // Defensive: any allocation fail → leave originals untouched so we
    // degrade to "buggy but functional" instead of "broken".
    if (!cpuValues || !threadCpuValues || !memValues || !resourceValues) return result;

    var _cpuUsage = binding.cpuUsage;
    var _threadCpuUsage = binding.threadCpuUsage;
    var _memoryUsage = binding.memoryUsage;
    var _resourceUsage = binding.resourceUsage;
    var _rss = binding.rss;

    result.cpuUsage = function cpuUsage(prevValue) {
      if (prevValue) {
        if (!previousValueIsValid(prevValue.user)) {
          throw mkErr('ERR_INVALID_ARG_VALUE', 'prevValue.user');
        }
        if (!previousValueIsValid(prevValue.system)) {
          throw mkErr('ERR_INVALID_ARG_VALUE', 'prevValue.system');
        }
      }
      _cpuUsage(cpuValues);
      if (prevValue) {
        return { user: cpuValues[0] - prevValue.user, system: cpuValues[1] - prevValue.system };
      }
      return { user: cpuValues[0], system: cpuValues[1] };
    };

    result.threadCpuUsage = function threadCpuUsage(prevValue) {
      if (prevValue) {
        if (!previousValueIsValid(prevValue.user)) {
          throw mkErr('ERR_INVALID_ARG_VALUE', 'prevValue.user');
        }
        if (!previousValueIsValid(prevValue.system)) {
          throw mkErr('ERR_INVALID_ARG_VALUE', 'prevValue.system');
        }
      }
      if (typeof process !== 'undefined' && process.platform === 'sunos') {
        var e = new Error('threadCpuUsage is not available on SunOS');
        e.code = 'ERR_OPERATION_FAILED';
        throw e;
      }
      _threadCpuUsage(threadCpuValues);
      if (prevValue) {
        return { user: threadCpuValues[0] - prevValue.user, system: threadCpuValues[1] - prevValue.system };
      }
      return { user: threadCpuValues[0], system: threadCpuValues[1] };
    };

    function memoryUsage() {
      _memoryUsage(memValues);
      return {
        rss: memValues[0],
        heapTotal: memValues[1],
        heapUsed: memValues[2],
        external: memValues[3],
        arrayBuffers: memValues[4],
      };
    }
    // \`process.memoryUsage.rss\` is a documented alias for the rss-only
    // C++ fast path — preserve it.
    memoryUsage.rss = _rss;
    result.memoryUsage = memoryUsage;

    result.resourceUsage = function resourceUsage() {
      _resourceUsage(resourceValues);
      return {
        userCPUTime: resourceValues[0],
        systemCPUTime: resourceValues[1],
        maxRSS: resourceValues[2],
        sharedMemorySize: resourceValues[3],
        unsharedDataSize: resourceValues[4],
        unsharedStackSize: resourceValues[5],
        minorPageFault: resourceValues[6],
        majorPageFault: resourceValues[7],
        swappedOut: resourceValues[8],
        fsRead: resourceValues[9],
        fsWrite: resourceValues[10],
        ipcSent: resourceValues[11],
        ipcReceived: resourceValues[12],
        signalsCount: resourceValues[13],
        voluntaryContextSwitches: resourceValues[14],
        involuntaryContextSwitches: resourceValues[15],
      };
    };

    return result;
  };
})();
`;

export const processMethodsWasmState: Policy = {
  name: "process-methods-wasm-state",
  description: "Make process.{cpu,threadCpu,memory,resource}Usage()'s internal Float64Arrays wasm-backed so JS reads see the C++ writes from the SAME call (fixes silent stale-by-one bug — see E19/E20). Depends on buffer-wasm-aliased.",
  builtinOverrides: {
    "internal/process/per_thread": { post: POST_PATCH },
  },
};
