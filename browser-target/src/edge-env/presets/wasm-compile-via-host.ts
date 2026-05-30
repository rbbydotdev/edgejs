import type { Preset } from "../types";

// Route `WebAssembly.compile` / `compileStreaming` / `instantiate` /
// `instantiateStreaming` through the host's native WebAssembly engine
// instead of edge's bundled (potentially shadowed) intrinsic.
//
// WHY
//
// Edge.js runs on a wasm-compiled Node embedded V8.  When user code inside
// that runtime calls `WebAssembly.compile(bytes)`, the compile work goes
// through the wasm-side V8 — which itself is running on wasm.  That's a
// double-virtualization tax: every byte of the input wasm module is parsed
// and compiled by a V8 that's itself executing as wasm.  Routing to the
// host snapshot uses the OUTER V8's WebAssembly engine — native code, real
// JIT — and hands the resulting Module/Instance back across the boundary.
//
// SHARED INTRINSIC NOTE
//
// `WebAssembly.Module`, `Instance`, `Memory`, `Table`, `Tag`, `Global` are
// intrinsics — edge's bootstrap freezes them but does NOT replace them with
// shimmed-in copies (see `lib/internal/freeze_intrinsics.js`).  Because of
// that, `mod instanceof WebAssembly.Module` continues to work for objects
// returned by the host: the host's V8 and the user-code's V8 view of the
// `WebAssembly` namespace share the same Module/Instance constructors when
// the user-code context is the same isolate (which it is — edge runs the
// user `-e` script in its own bundled V8, but `WebAssembly` itself isn't
// polyfilled at the lib layer).
//
// WHAT IT DOES NOT TOUCH
//
// - `new WebAssembly.Module(bytes)` (the synchronous form) — host snapshot
//   only captures the async APIs.  Sync Module construction stays on the
//   bundled engine.  Code that wants the perf win should use the async path.
// - `WebAssembly.validate` is also snapshotted; userland override is opt-in
//   below since validate is rare and cheap anyway.
//
// COMPOSITION
//
// Opt-in preset.  Not in `minimalPolicies` or `defaultBrowserPolicies`.
// Pairs naturally with engines that have JSPI active (the `.then` callback
// on a host-returned Promise needs the wasm-side microtask queue to drain;
// the JSPI yield strategy ensures that).  On non-JSPI engines the override
// still installs cleanly — the Promise just resolves via the standard host
// microtask plumbing, which works because the user script's `.then`
// continuation runs in the SAME shared globalThis.
//
// HOW IT REACHES THE LIB
//
// No edge lib module exposes `WebAssembly` — it's an intrinsic, not a
// `require()`-able builtin.  So the override lives in `inject`,
// which is concatenated in front of the user's `-e` script.  The prelude
// swaps `globalThis.WebAssembly.compile` (etc.) with thin wrappers that
// call the host snapshot.

const PRELUDE = `try {
  (function applyWasmCompileViaHost() {
    if (typeof WebAssembly === 'undefined' || !WebAssembly) return;
    var snap = (typeof globalThis !== 'undefined' && globalThis.__edgeHostWebAssembly) || null;
    if (!snap) return;

    // Replace each async method only when the host snapshot has a real
    // function for it.  Fall back to the original (un-routed) method when
    // the host doesn't expose it (e.g. older engines without
    // \`compileStreaming\`).  Replacement happens via property assignment
    // on \`WebAssembly\` itself — those slots are writable even after
    // edge's intrinsic freeze (the freeze targets prototypes, not the
    // namespace object's own properties).
    function tryReplace(name) {
      if (typeof snap[name] !== 'function') return;
      try {
        // Capture a tag on each wrapper so tests can verify the routing
        // actually took effect (without needing perf measurements).  See
        // tests/js/wasm-compile-via-host-policy.js.
        var hostFn = snap[name];
        function wrapper() {
          // Apply with no \`this\` — host-bound function already has
          // its \`this\` set by globals-shim's \`.bind()\`.
          return hostFn.apply(null, arguments);
        }
        wrapper.__edgeViaHost = true;
        wrapper.__edgeRoute = name;
        // Some engines reject reassignment of native WebAssembly methods
        // (frozen by edge's freeze_intrinsics or non-writable descriptor).
        // Use defineProperty as a fallback when plain assignment doesn't
        // stick.
        var prev = WebAssembly[name];
        WebAssembly[name] = wrapper;
        if (WebAssembly[name] !== wrapper) {
          try {
            Object.defineProperty(WebAssembly, name, {
              value: wrapper, writable: true, configurable: true, enumerable: false,
            });
          } catch (eDP) { void eDP; /* leave prev in place */ }
        }
        void prev;
      } catch (eOuter) { void eOuter; /* skip on any failure */ }
    }

    tryReplace('compile');
    tryReplace('compileStreaming');
    tryReplace('instantiate');
    tryReplace('instantiateStreaming');
    tryReplace('validate');
  })();
} catch (eTop) { void eTop; }
`;

export const wasmCompileViaHost: Preset = {
  name: "wasm-compile-via-host",
  description: "Route WebAssembly.compile / compileStreaming / instantiate / instantiateStreaming through the host's native engine via globalThis.__edgeHostWebAssembly. Async APIs only; sync `new WebAssembly.Module(bytes)` unchanged.",
  inject: PRELUDE,
};
