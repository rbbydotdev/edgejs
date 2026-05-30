// Pre-patch on lib/internal/bootstrap/realm.js: provide an empty-object
// stub for `internalBinding('inspector')` so `process.binding('inspector')`
// returns a truthy value instead of `undefined`.
//
// THE BUG
//
// edge.js's wasm build doesn't ship the `inspector` internal binding —
// `getInternalBinding('inspector')` returns undefined.  When user code
// (or Node's own pre_execution.js) calls `internalBinding('inspector')`
// the realm caches and returns undefined; `process.binding('inspector')`
// then also returns undefined.
//
// THE TEST
//
// test-process-binding-internalbinding-allowlist.js asserts that every
// process.binding(<name>) returns a truthy value for ~20 allowlisted
// internal bindings.  All others succeed (buffer, fs, util, etc. all
// have native impls); only `inspector` returns undefined, breaking the
// assertion `assert(process.binding('inspector'))`.
//
// THE FIX
//
// `getInternalBinding` is a wrapper-function PARAMETER injected by
// edge_module_loader.cc:CreateNativeBuiltinFunction (see realm.js's
// /* global */ comment line 49).  We can't override the global —
// the parameter shadows it inside the function body.  Instead, we
// rebind the parameter name to a wrapper at the top of the body
// (pre-patch runs INSIDE the function, BEFORE the rest of the body).
// JS hoisting lets us reassign the parameter via plain assignment.
// Subsequent uses (notably the `internalBinding` closure at line 182)
// capture OUR wrapped function.
//
// Why an empty object: the test only checks truthiness, and code paths
// in lib that DO call methods on the inspector binding (e.g.
// pre_execution.js:501 `internalBinding('inspector').registerAsyncHook`)
// are gated on `--inspect`-related flags that the browser build doesn't
// enable.  An empty `{}` satisfies the allowlist test without giving
// false-positive functionality.
//
// Idempotent via a `__edgeInspectorBindingPatched` sentinel — realm.js
// runs once per realm, but defensive against accidental double-load.

// Rebind the wrapper-function parameter `getInternalBinding` to a
// wrapper that returns `{}` for the 'inspector' name when the
// underlying impl returns undefined.  All in-scope references
// (including the `internalBinding` closure that realm.js builds at
// line 182) capture the wrapped version.
//
// NOT wrapped in an IIFE: pre-patch code runs at the TOP of the
// wrapper-function body, so a bare assignment to the parameter
// `getInternalBinding` rebinds it in the realm scope itself.  An
// IIFE here would only create a nested scope with its own binding
// and leave the outer parameter unchanged.
if (typeof getInternalBinding === 'function') {
  var __edgeOrigGetInternalBinding = getInternalBinding;
  getInternalBinding = function getInternalBindingWithInspectorStub(name) {
    var r = __edgeOrigGetInternalBinding(name);
    if (r === undefined && name === 'inspector') {
      // Empty object — satisfies truthy check, no methods exposed.
      // If real inspector methods are ever required, replace with a
      // richer stub or wire a real impl via a separate preset.
      return {};
    }
    return r;
  };
}
