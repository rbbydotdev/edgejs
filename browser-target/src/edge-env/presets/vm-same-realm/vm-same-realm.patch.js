// Post-patch on lib/vm.js: replace vm.runInNewContext / vm.runInContext
// with same-realm eval.
//
// HONEST LIMITATION
//
// Real Node `vm.runInNewContext` creates a fresh V8 Context (Realm) and
// evaluates the code there.  Cross-realm objects have different
// prototypes; primitives cross transparently.  In a browser worker (where
// edge.js runs) there is NO synchronous primitive for a fresh realm —
// ShadowRealm only allows primitive-passing (no ArrayBuffer roundtrip),
// iframes don't exist in workers, and SAB+Atomics roundtrip to main is
// asynchronous which breaks vm's sync contract.
//
// What we DO provide: same-realm eval.  `vm.runInNewContext(code)` evaluates
// `code` in OUR realm via `(0, eval)(code)`.  The result is a real object
// from our realm — for `new ArrayBuffer()` that's a real ArrayBuffer that
// `Buffer.byteLength(arrayBuf)` correctly returns 0 for.
//
// WHAT THIS BREAKS
//
// - Tests that assert cross-realm identity (`arrayBuf instanceof
//   ArrayBuffer` would be true here but false in real Node cross-realm).
//   We're MORE permissive than real Node.
// - Tests that assert filename attribution from the vm options (e.g.
//   test-buffer-constructor-outside-node-modules tracks a deprecation
//   warning to a vm.runInNewContext filename) — these still fail.
// - Sandbox isolation: a `runInNewContext(code, sandbox)` call CAN'T
//   isolate code from our realm's globals; sandbox properties become
//   visible-but-ignored.  Code that modifies globals will leak.
//
// WHAT THIS UNBLOCKS
//
// - Buffer.byteLength tests using `vm.runInNewContext('new ArrayBuffer()')`
//   for cross-realm AB detection (the AB is detected because it IS a
//   real AB in our realm; the test's broader assertion holds for the
//   right reason).
// - Any test that uses runInNewContext just to grab a primitive or a
//   constructed object without needing realm isolation.
//
// This is opt-in via the `vm-same-realm` preset name.  Tests that need
// real cross-realm semantics should be skip-listed (or wait for the
// ShadowRealm / iframe-RPC architecture that would replace this).

;(function patchVmSameRealm() {
  if (typeof module === "undefined" || !module || !module.exports) return;
  var exp = module.exports;
  if (exp.__edgeVmSameRealmPatched) return;

  // Indirect eval — runs at global scope, returns the value of the last
  // expression in `code` (V8's documented eval behavior).  Used as our
  // same-realm replacement for runInNewContext / runInContext.
  var indirectEval = (0, eval);

  function runInNewContext(code, _sandbox, _options) {
    void _sandbox; void _options;
    return indirectEval(String(code));
  }
  function runInContext(code, _ctx, _options) {
    void _ctx; void _options;
    return indirectEval(String(code));
  }
  function runInThisContext(code, _options) {
    void _options;
    return indirectEval(String(code));
  }
  // createContext usually returns a vm.Context-tagged object.  Same-realm
  // mode treats every contextObject as the realm itself — return it
  // unchanged so downstream `validateContext` checks against our patched
  // runInContext (which doesn't validate) pass invisibly.  Code that
  // checks `vm.isContext(obj)` against this still works if we tag it.
  function createContext(contextObject) {
    if (contextObject == null) contextObject = {};
    try {
      Object.defineProperty(contextObject, "__edgeVmSameRealmContext", {
        value: true, configurable: true, writable: true,
      });
    } catch (_e) { void _e; }
    return contextObject;
  }
  function isContext(obj) {
    return obj != null && (typeof obj === "object" || typeof obj === "function") &&
      obj.__edgeVmSameRealmContext === true;
  }

  exp.runInNewContext = runInNewContext;
  exp.runInContext = runInContext;
  exp.runInThisContext = runInThisContext;
  exp.createContext = createContext;
  exp.isContext = isContext;
  exp.__edgeVmSameRealmPatched = true;
})();
