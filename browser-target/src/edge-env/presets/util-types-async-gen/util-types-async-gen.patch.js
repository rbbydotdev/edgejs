// Pre-patch on lib/internal/util/types.js: fix isAsyncFunction /
// isGeneratorFunction detection for AsyncGeneratorFunction values.
//
// THE BUG
//
// Real Node (V8) defines BOTH isAsyncFunction AND isGeneratorFunction
// to return true for an async generator (`async function* fn() {}`),
// because V8 tracks the function kind bits separately — an async
// generator IS both "async" AND "generator".  util.inspect leverages
// this at lib/internal/util/inspect.js:1313-1319 to build the type
// name "AsyncGeneratorFunction":
//
//   let type = 'Function';
//   if (isGeneratorFunction(value)) type = `Generator${type}`;
//   if (isAsyncFunction(value)) type = `Async${type}`;
//
// Edge.js's wasm `internalBinding('types').isAsyncFunction` returns
// false for async generators — it only recognizes the pure `async`
// kind.  Result: util.inspect prints `[GeneratorFunction: abc]
// AsyncGeneratorFunction` (the trailing tag comes from
// @@toStringTag) instead of the expected `[AsyncGeneratorFunction:
// abc]`.  Fails test-util-inspect.js:56.
//
// We can't reach into the wasm runtime to fix the binding's kind
// detection, but we CAN distinguish async generators from JS by
// reading the function's prototype.  Each function kind has a
// distinct prototype (AsyncGeneratorFunction.prototype etc.) obtained
// from `Object.getPrototypeOf(asyncGenFn).constructor.prototype`.
// Stash the canonical prototypes at patch time and compare via
// `instanceof`.
//
// THE FIX
//
// Pre-patch on lib/internal/util/types.js — BEFORE the top-level
// `module.exports = { ...internalBinding('types'), ... }` spread
// destructures the binding.  Mutate `internalBinding('types')` in
// place so isAsyncFunction / isGeneratorFunction return true for
// async generators as well as their pure-kind counterparts.

;(function patchUtilTypesAsyncGen() {
  if (typeof internalBinding !== "function") return;
  var b;
  try { b = internalBinding("types"); } catch (_e) { return; }
  if (!b) return;
  if (b.__edgeAsyncGenTypesPatched) return;

  // Resolve the four function-kind constructors via canonical eval.
  // `(0, eval)` runs in the global scope so this works even when the
  // patch body runs inside a module's function wrapper.
  var AsyncGeneratorFunction, AsyncFunction, GeneratorFunction;
  try {
    AsyncGeneratorFunction = (0, eval)("(async function*(){}).constructor");
    AsyncFunction = (0, eval)("(async function(){}).constructor");
    GeneratorFunction = (0, eval)("(function*(){}).constructor");
  } catch (_e) {
    // Engine without one of these constructors — bail out cleanly.
    return;
  }

  var origIsAsyncFunction = typeof b.isAsyncFunction === "function" ? b.isAsyncFunction : null;
  var origIsGeneratorFunction = typeof b.isGeneratorFunction === "function" ? b.isGeneratorFunction : null;

  function isAsyncFunction(value) {
    if (typeof value !== "function") return false;
    if (origIsAsyncFunction !== null && origIsAsyncFunction(value)) return true;
    // AsyncGeneratorFunction is "async" too — match real Node behavior.
    return AsyncGeneratorFunction !== undefined && value instanceof AsyncGeneratorFunction;
  }

  function isGeneratorFunction(value) {
    if (typeof value !== "function") return false;
    if (origIsGeneratorFunction !== null && origIsGeneratorFunction(value)) return true;
    return AsyncGeneratorFunction !== undefined && value instanceof AsyncGeneratorFunction;
  }
  void GeneratorFunction;
  void AsyncFunction;

  try {
    Object.defineProperty(b, "isAsyncFunction", {
      configurable: true, writable: true, value: isAsyncFunction,
    });
    Object.defineProperty(b, "isGeneratorFunction", {
      configurable: true, writable: true, value: isGeneratorFunction,
    });
    Object.defineProperty(b, "__edgeAsyncGenTypesPatched", {
      configurable: true, writable: true, value: true,
    });
  } catch (_e) {
    b.isAsyncFunction = isAsyncFunction;
    b.isGeneratorFunction = isGeneratorFunction;
    b.__edgeAsyncGenTypesPatched = true;
  }
})();
