// Pre-patch on lib/internal/util/comparisons.js: replace
// internalBinding('util').getOwnNonIndexProperties with a JS impl that
// honors V8's PropertyFilter semantics.
//
// THE BUG
//
// Edge's wasm-side `getOwnNonIndexProperties(obj, filter)` returns ALL
// non-index property names regardless of the filter bits.  In particular,
// `getOwnNonIndexProperties([], ONLY_ENUMERABLE)` returns `["length"]`
// even though Array's `length` property is non-enumerable.
//
// This silently breaks assert.deepStrictEqual for ALL Array comparisons
// — at lib/internal/util/comparisons.js:294 the function reads
// `getOwnNonIndexProperties(val2, filter).length` and compares against
// the same for val1; both have "length" reported as a property, so the
// counts match (1 === 1), so we don't shortcut.  Then keyCheck iterates
// keys2 with `length` in it, asserts strict equality on `val1.length`
// vs `val2.length` — wait actually that part works too.  The actual
// breakage is subtle: the spurious `length` key in keys2 makes the deep
// comparison report "structurally equal" because length values match,
// BUT the outer assertion engine notices the difference via a separate
// path (the actualVisited / expectedVisited Map keys differ since they
// keyed off the SAME object references at different stages) and emits
// notIdentical.
//
// Net visible effect: `assert.deepStrictEqual([], [])` THROWS with
// "Values have same structure but are not reference-equal" — 12 failing
// events tests + a handful elsewhere all trace to this.
//
// THE FIX
//
// Replace the binding's getOwnNonIndexProperties with a JS impl that:
//   - Iterates Object.getOwnPropertyNames(obj) (skips Symbols by default)
//   - Skips index-like keys (the spec defines "index" as numeric strings)
//   - Honors the V8 PropertyFilter bits via getOwnPropertyDescriptor
//
// V8 PropertyFilter values (from deps/v8/include/v8-object.h):
//   ALL_PROPERTIES     = 0
//   ONLY_WRITABLE      = 1
//   ONLY_ENUMERABLE    = 2
//   ONLY_CONFIGURABLE  = 4
//   SKIP_STRINGS       = 8
//   SKIP_SYMBOLS       = 16
// Filter bits semantics: when ONLY_X is set, INCLUDE only props that
// are X.  When SKIP_X is set, EXCLUDE props of type X.  (V8's enum is
// "only-include" for the first three, "skip-this-type" for the last
// two — they're not symmetric.)

;(function patchGetOwnNonIndexProperties() {
  if (typeof internalBinding !== "function") return;
  var b;
  try { b = internalBinding("util"); } catch (_e) { return; }
  if (!b) return;
  if (b.__edgeGetOwnNonIndexPatched) return;

  // The constants object on the binding already has the right numeric
  // values (verified at runtime: ALL_PROPERTIES=0, ONLY_ENUMERABLE=2,
  // etc.).  Reading from the binding rather than hardcoding keeps us
  // robust to future edge changes.
  var C = b.constants || {};
  var ONLY_WRITABLE = C.ONLY_WRITABLE | 0;
  var ONLY_ENUMERABLE = C.ONLY_ENUMERABLE | 0;
  var ONLY_CONFIGURABLE = C.ONLY_CONFIGURABLE | 0;
  var SKIP_STRINGS = C.SKIP_STRINGS | 0;
  var SKIP_SYMBOLS = C.SKIP_SYMBOLS | 0;

  // A string key is "index-like" iff it's a canonical array index:
  // a string of decimal digits whose Number-conversion is < 2^32 - 1
  // and round-trips through String exactly.
  function isIndexKey(key) {
    if (typeof key !== "string" || key.length === 0) return false;
    if (key === "0") return true;
    var c0 = key.charCodeAt(0);
    if (c0 < 49 /* '1' */ || c0 > 57 /* '9' */) return false;
    var n = +key;
    return n < 4294967295 && String(n) === key;
  }

  function getOwnNonIndexProperties(obj, filter) {
    filter = filter | 0;
    var skipStrings = (filter & SKIP_STRINGS) !== 0;
    var skipSymbols = (filter & SKIP_SYMBOLS) !== 0;
    var requireWritable = (filter & ONLY_WRITABLE) !== 0;
    var requireEnumerable = (filter & ONLY_ENUMERABLE) !== 0;
    var requireConfigurable = (filter & ONLY_CONFIGURABLE) !== 0;
    var result = [];

    if (!skipStrings) {
      var names = Object.getOwnPropertyNames(obj);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if (isIndexKey(name)) continue;
        if (requireWritable || requireEnumerable || requireConfigurable) {
          var d = Object.getOwnPropertyDescriptor(obj, name);
          if (!d) continue;
          if (requireWritable && !("writable" in d ? d.writable : true)) continue;
          if (requireEnumerable && !d.enumerable) continue;
          if (requireConfigurable && !d.configurable) continue;
        }
        result.push(name);
      }
    }
    if (!skipSymbols) {
      var syms = Object.getOwnPropertySymbols(obj);
      for (var j = 0; j < syms.length; j++) {
        var sym = syms[j];
        if (requireWritable || requireEnumerable || requireConfigurable) {
          var ds = Object.getOwnPropertyDescriptor(obj, sym);
          if (!ds) continue;
          if (requireWritable && !("writable" in ds ? ds.writable : true)) continue;
          if (requireEnumerable && !ds.enumerable) continue;
          if (requireConfigurable && !ds.configurable) continue;
        }
        result.push(sym);
      }
    }
    return result;
  }

  try {
    Object.defineProperty(b, "getOwnNonIndexProperties", {
      configurable: true, writable: true, value: getOwnNonIndexProperties,
    });
    Object.defineProperty(b, "__edgeGetOwnNonIndexPatched", {
      configurable: true, writable: true, value: true,
    });
  } catch (_e) {
    b.getOwnNonIndexProperties = getOwnNonIndexProperties;
    b.__edgeGetOwnNonIndexPatched = true;
  }
})();
