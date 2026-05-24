# E20: process-methods-wasm-state policy — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a88f0562b0c8fe109` (port 5194)
**Result:** **Policy shipped in `minimalPolicies` + `defaultBrowserPolicies`.**
Closes the 4 staleness bugs E19 surfaced.  Suite: 33/0/3 → 34/0/3.

## Implementation note (deviation from initial plan)

The original plan assumed the 4 `Float64Array`s were at module scope
in `lib/internal/process/per_thread.js`, so a `{post}` patch could
replace them directly.  In reality they sit **inside**
`wrapProcessMethods(binding)`'s closure (not module scope), so a
direct text replacement can't reach them.

The policy wraps `module.exports.wrapProcessMethods` instead: after
the original returns the 4 result methods, the policy REPLACES those
methods with versions that use wasm-backed Float64Arrays.  Cleaner
than zlib's class-extends gymnastics.

## Implementation

File: `browser-target/src/policies/process-methods-wasm-state.ts`
(~200 lines including comments; ~30 LOC actual logic).

```js
const POST_PATCH = `
;(function applyProcessMethodsWasmState() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var origWrap = module.exports.wrapProcessMethods;
  if (typeof origWrap !== 'function') return;
  var bufBinding;
  try { bufBinding = internalBinding('buffer'); } catch (_e) { return; }
  var cuab = bufBinding && bufBinding.createUnsafeArrayBuffer;
  if (typeof cuab !== 'function') return;

  function makeWasmFloat64(n) {
    var u8;
    try { u8 = cuab(n * 8); } catch (_e) { return null; }
    if (!u8 || !ArrayBuffer.isView(u8)) return null;
    new Uint8Array(u8.buffer, u8.byteOffset, n * 8).fill(0);
    return new Float64Array(u8.buffer, u8.byteOffset, n);
  }

  module.exports.wrapProcessMethods = function wrapProcessMethodsPatched(binding) {
    var result = origWrap(binding);
    if (!result || typeof result !== 'object') return result;
    var cpuValues = makeWasmFloat64(2);
    var threadCpuValues = makeWasmFloat64(2);
    var memValues = makeWasmFloat64(5);
    var resourceValues = makeWasmFloat64(16);
    if (!cpuValues || !threadCpuValues || !memValues || !resourceValues) return result;
    // ... replaced methods that pass the wasm-backed views to
    //     binding.cpuUsage / .threadCpuUsage / .memoryUsage / .resourceUsage
    return result;
  };
})();`;
```

Wired into `policies/index.ts`: added to exports, imports,
`minimalPolicies`, `defaultBrowserPolicies`, `policyRegistry`.

## Test

`tests/js/process-methods-staleness.{js,harness-args,stdout}` —
exercises all 4 APIs.

`harness-args`: `--policies buffer-pool-disable,buffer-wasm-aliased,process-methods-wasm-state`

Expected stdout:
```
cpu1-fresh
cpu-diff-shape-ok
mem-shape-ok
rss-alias-present
resource-shape-ok
resource-repeatable
e20-ok
```

The `cpu1-fresh` check is the main staleness signal: without the
policy, `process.cpuUsage()` returns `{user: 0, system: 0}` on first
call (JS-heap initial); with the policy, returns real `uv_getrusage`
values.

## Default-vs-opt-in

**Shipped in `minimalPolicies` + `defaultBrowserPolicies`.**
Reasoning:
- Silent correctness bug in widely-used telemetry APIs — worst kind
  to leave latent.
- Patch is behaviorally transparent: if `buffer-wasm-aliased` isn't
  active, `cuab` returns a plain ArrayBuffer, `ArrayBuffer.isView`
  fails, `makeWasmFloat64` returns null, and we no-op back to the
  unpatched originals.
- Same risk profile as `zlib-writestate-wasm` (already in
  `minimalPolicies`).

## Open / notes

- **`memoryUsage` returns all zeros in this wasm build.**
  `uv_resident_set_memory` / `unofficial_napi_get_process_memory_info`
  have no real OS to query.  The staleness fix is structurally
  correct (verified via `cpuUsage` which DOES return real values);
  a deterministic mem-delta test wasn't viable, so the test asserts
  shape only for mem/resource and value-content only for cpu.
- **`per_thread.js` evaluates twice during bootstrap** (one per
  realm: main + worker).  Both copies get the patch independently —
  no interference.
- **No shared helper with `zlib-writestate-wasm`.**  Both fix the
  same bug class but the structures differ (zlib wraps
  `binding.X.prototype.init` for per-instance class state; this
  wraps a module-exported factory for module-scope state).  A
  generalized helper would over-abstract two sites.  See
  `docs/wasm-aliased-typedarray-pattern.md` for the threshold
  ("escalate when a third NEW binding is affected AND the policies
  have meaningful shared code AND duplication is >30 lines").

## Files changed in main

- `browser-target/src/policies/process-methods-wasm-state.ts` (new)
- `browser-target/src/policies/index.ts` — exports + imports +
  `minimalPolicies` + `defaultBrowserPolicies` + `policyRegistry`
- `tests/js/process-methods-staleness.{js,harness-args,stdout}` (new)
