// Pre-patch on lib/internal/util/inspect.js: install a JS-side
// constructor-name registry so internalBinding('util').getConstructorName
// can return the ORIGINAL constructor name for objects whose prototype
// has been swapped to null (or to a chain without a useful constructor).
//
// THE BUG
//
// Real V8 stores the constructor name in the object's hidden Map at
// allocation time.  `obj->GetConstructorName()` reads that slot, so
// even after `Object.setPrototypeOf(new Foo(), null)`, V8 still
// returns "Foo".  This is what util.inspect uses (via getCtxStyle →
// internalGetConstructorName) to format the prefix:
//
//   util.format('%s', Object.setPrototypeOf(new Foo(), null))
//     // expected: '[Foo: null prototype] {}'
//     // edge.js : '[Object: null prototype] {}'   ← BUG
//
// Edge.js's wasm getConstructorName follows the prototype chain.  Once
// the prototype is null, the chain ends and it falls back to "Object".
// There's no JS-level reflection that recovers the original kind.
//
// THE FIX
//
// Patch `Object.setPrototypeOf` and `Reflect.setPrototypeOf` to stash
// the current constructor name into a WeakMap BEFORE the prototype is
// swapped.  Then replace `internalBinding('util').getConstructorName`
// with a JS impl that consults the WeakMap first, falling back to the
// binding's original behavior for objects whose prototype was never
// swapped.
//
// LIMITATIONS
//
// - Catches Object.setPrototypeOf / Reflect.setPrototypeOf only.  The
//   `__proto__` setter could also swap the prototype; we don't patch
//   that because it's deprecated and the failing tests don't exercise
//   it (and patching the accessor reliably across realms is fragile).
// - Catches only swaps to a NEW prototype that doesn't itself provide
//   a usable constructor name.  We always stash, but the JS
//   getConstructorName only uses the cache when the live binding
//   returns "Object" (and the cached name is something else) — that
//   way ordinary subclassing still works through the binding.

;(function patchGetConstructorName() {
  if (typeof internalBinding !== "function") return;
  var b;
  try { b = internalBinding("util"); } catch (_e) { return; }
  if (!b) return;
  if (b.__edgeGetConstructorNamePatched) return;

  var g = (function () { return this || (0, eval)("this"); })();
  if (!g) return;

  var origBindingFn = typeof b.getConstructorName === "function" ? b.getConstructorName : null;

  // Shared registry across all modules: stash original constructor
  // names before a prototype swap.  Idempotent — a previous module-
  // load may have already installed it.
  var registry;
  if (g.__edgeConstructorNameRegistry !== undefined) {
    registry = g.__edgeConstructorNameRegistry;
  } else {
    registry = new WeakMap();
    g.__edgeConstructorNameRegistry = registry;

    // Resolve the constructor name the way V8 / Node would, BEFORE
    // the prototype is changed.  Walks the prototype chain looking
    // for `constructor.name` — same shape as JS-level fallback in
    // inspect.js getConstructorName.
    function resolveName(obj) {
      if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return null;
      var cur = obj;
      var guard = 0;
      while (cur !== null && cur !== undefined && guard++ < 100) {
        var desc;
        try { desc = Object.getOwnPropertyDescriptor(cur, "constructor"); }
        catch (_e) { return null; }
        if (desc !== undefined &&
            typeof desc.value === "function" &&
            typeof desc.value.name === "string" &&
            desc.value.name !== "") {
          return desc.value.name;
        }
        try { cur = Object.getPrototypeOf(cur); }
        catch (_e) { return null; }
      }
      return null;
    }

    function rememberCtorName(obj) {
      if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return;
      try {
        if (registry.has(obj)) return;  // Don't overwrite — first swap wins.
        var name = resolveName(obj);
        if (name !== null && name !== "Object") {
          registry.set(obj, name);
        }
      } catch (_e) {}
    }

    var origSetProto = Object.setPrototypeOf;
    if (typeof origSetProto === "function") {
      try {
        Object.setPrototypeOf = function setPrototypeOf(obj, proto) {
          rememberCtorName(obj);
          return origSetProto.call(Object, obj, proto);
        };
      } catch (_e) {}
    }
    if (typeof Reflect === "object" && Reflect !== null) {
      var origReflectSetProto = Reflect.setPrototypeOf;
      if (typeof origReflectSetProto === "function") {
        try {
          Reflect.setPrototypeOf = function setPrototypeOf(obj, proto) {
            rememberCtorName(obj);
            return origReflectSetProto.call(Reflect, obj, proto);
          };
        } catch (_e) {}
      }
    }
  }

  function getConstructorName(obj) {
    var live = null;
    if (origBindingFn !== null) {
      try { live = origBindingFn(obj); } catch (_e) { live = null; }
    }
    // Prefer the binding's result UNLESS it fell back to "Object" — in
    // which case we may have a better answer in the registry.
    if (live !== null && live !== undefined && live !== "Object") {
      return live;
    }
    var cached = null;
    try { cached = registry.get(obj); } catch (_e) {}
    if (typeof cached === "string" && cached !== "" && cached !== "Object") {
      return cached;
    }
    return live !== null && live !== undefined ? live : "Object";
  }

  try {
    Object.defineProperty(b, "getConstructorName", {
      configurable: true, writable: true, value: getConstructorName,
    });
    Object.defineProperty(b, "__edgeGetConstructorNamePatched", {
      configurable: true, writable: true, value: true,
    });
  } catch (_e) {
    b.getConstructorName = getConstructorName;
    b.__edgeGetConstructorNamePatched = true;
  }
})();
