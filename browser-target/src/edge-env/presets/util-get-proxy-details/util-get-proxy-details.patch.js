// Pre-patch on lib/internal/util/inspect.js: install a JS-side proxy
// registry so internalBinding('util').getProxyDetails can identify
// Proxy values created via the global `Proxy` constructor.
//
// THE BUG
//
// Edge.js's wasm `internalBinding('util').getProxyDetails(value, full)`
// returns `undefined` for every Proxy — its wasm-side type tag table
// has no entry for Proxy objects, so it can't distinguish them from
// ordinary objects.  lib/internal/util/inspect.js relies on this
// binding at two critical points:
//
//   - formatValue (line 872): `getProxyDetails(value, !!ctx.showProxy)`
//     unwraps the proxy target so subsequent property reads (`tag =
//     value[SymbolToStringTag]`, the customInspect lookup, etc.) hit
//     the TARGET — not the proxy.  Without this, the proxy's `get`
//     trap fires.
//   - hasBuiltInToString (line 2431): same unwrap, used by %s format
//     spec to decide whether to call inspect or String().
//
// test-util-inspect-proxy.js installs a Proxy whose every trap throws
// (`get() { throw new Error('get'); }` etc.).  Inspecting that proxy
// or formatting it with %s should NOT trigger any trap.  Without a
// working getProxyDetails, util.format('%s', proxyObj) reaches
// hasBuiltInToString → `value.toString` → throws Error: get.
//
// THE FIX
//
// There is no pure-JS way to detect that an arbitrary object is a
// Proxy.  So we instead wrap the global `Proxy` constructor at patch
// time and record every Proxy we construct in a WeakMap (proxy →
// [target, handler, isRevoked, revoke]).  Then we replace the
// binding's `getProxyDetails(value, full)` with a JS impl that
// consults the WeakMap.
//
// LIMITATIONS
//
// - Only catches proxies constructed via the patched global `Proxy`.
//   Proxies built inside compiled built-ins or vendored libs that
//   captured `Proxy` BEFORE this patch ran won't appear in our
//   registry.  We mitigate by pre-patching on `internal/util/inspect`
//   so the wrap happens before user code runs; built-in modules
//   loaded earlier are not expected to construct user-visible proxies.
// - Proxy.revocable is supported: the revoke function flips the
//   isRevoked flag so we return `null` from getProxyDetails (matching
//   the test's expectation at line 67-71).
// - Object.setPrototypeOf etc. are not affected.

;(function patchProxyDetails() {
  if (typeof internalBinding !== "function") return;
  var b;
  try { b = internalBinding("util"); } catch (_e) { return; }
  if (!b) return;
  if (b.__edgeProxyDetailsPatched) return;

  // Install Proxy wrapper at worker scope.  Idempotent — if a previous
  // module-load already wrapped Proxy, we skip and reuse its WeakMap.
  var g = (function () { return this || (0, eval)("this"); })();
  if (!g) return;
  var registry;
  if (g.__edgeProxyRegistry !== undefined) {
    registry = g.__edgeProxyRegistry;
  } else {
    registry = new WeakMap();
    g.__edgeProxyRegistry = registry;

    var NativeProxy = g.Proxy;
    if (typeof NativeProxy === "function") {
      function PatchedProxy(target, handler) {
        if (!(this instanceof PatchedProxy)) {
          // Proxy must be called with `new` per spec; native enforces this.
          // Replicate to keep error messages identical.
          throw new TypeError("Constructor Proxy requires 'new'");
        }
        var p = new NativeProxy(target, handler);
        try { registry.set(p, { target: target, handler: handler, revoked: false }); }
        catch (_e) {}
        return p;
      }
      // Preserve Proxy.revocable so user code can opt into revocation.
      PatchedProxy.revocable = function revocable(target, handler) {
        var r = NativeProxy.revocable(target, handler);
        var entry = { target: target, handler: handler, revoked: false };
        try { registry.set(r.proxy, entry); } catch (_e) {}
        var origRevoke = r.revoke;
        r.revoke = function revoke() {
          entry.revoked = true;
          entry.target = null;
          entry.handler = null;
          return origRevoke.apply(this, arguments);
        };
        return r;
      };
      // Length and name to match native.
      try {
        Object.defineProperty(PatchedProxy, "length", { value: 2, configurable: true });
        Object.defineProperty(PatchedProxy, "name", { value: "Proxy", configurable: true });
      } catch (_e) {}
      try { g.Proxy = PatchedProxy; } catch (_e) {}
    }
  }

  // Replace getProxyDetails on the binding.  Real Node semantics:
  //   getProxyDetails(value, full)
  //     - if value is not a Proxy: undefined
  //     - if value is a REVOKED Proxy: full ? [null, null] : null
  //     - if value is a live Proxy: full ? [target, handler] : target
  function getProxyDetails(value, full) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return undefined;
    }
    var entry;
    try { entry = registry.get(value); } catch (_e) { return undefined; }
    if (entry === undefined) return undefined;
    if (entry.revoked) {
      return full ? [null, null] : null;
    }
    return full ? [entry.target, entry.handler] : entry.target;
  }

  try {
    Object.defineProperty(b, "getProxyDetails", {
      configurable: true, writable: true, value: getProxyDetails,
    });
    Object.defineProperty(b, "__edgeProxyDetailsPatched", {
      configurable: true, writable: true, value: true,
    });
  } catch (_e) {
    b.getProxyDetails = getProxyDetails;
    b.__edgeProxyDetailsPatched = true;
  }
})();
