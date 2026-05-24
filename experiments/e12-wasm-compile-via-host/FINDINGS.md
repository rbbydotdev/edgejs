# E12: wasm-compile-via-host policy — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-ae5cc6cdd9153806a` (port 5187)
**Result:** Built from scratch (NOTES.md:527 listed it as planned-but-
unimplemented).  Shipped as opt-in.  Suite: 29/0/3 → 30/0/3.
Functionally correct; no measurable perf delta in this environment.

## Pre-existing state

Policy file did NOT exist.  Built from scratch following
`compression-via-compressionstream` / `crypto-host-random` shape.

## Globals-shim snapshot

Added `globalThis.__edgeHostWebAssembly` in `globals-shim.ts`.
Captures `compile`, `compileStreaming`, `instantiate`,
`instantiateStreaming`, `validate` — each `typeof === 'function'`-
gated and `.bind()`-ed so missing APIs leave `undefined` slots that
the policy treats as "skip this method."

Constructors (`Module`, `Instance`, ...) are NOT snapshotted — edge
freezes but doesn't replace them, so `instanceof` works across the
boundary.

## Policy implementation

`browser-target/src/policies/wasm-compile-via-host.ts` (~95 lines).
Uses `userScriptPrelude` (NOT `builtinOverrides`) — `WebAssembly` is
an intrinsic, not a `require()`-able builtin, so there's no module
body to `{post}`-patch.  The prelude reads
`globalThis.__edgeHostWebAssembly`, bails silently if absent, then
for each method installs a wrapper tagged with `__edgeViaHost=true`
and `__edgeRoute=<name>` (so tests can verify routing).  Tries plain
assignment first; falls back to `Object.defineProperty` with
`writable+configurable=true` if the intrinsic refuses reassignment.

Registered in `policyRegistry`; NOT in `minimalPolicies` or
`defaultBrowserPolicies`.

## Test

- `tests/js/wasm-compile-via-host-policy.js` — builds a 30-byte wasm
  module exporting `pi(): i32 → 314`, runs `compile().then(instantiate)
  .then(call .pi)`.
- `tests/js/wasm-compile-via-host-policy.harness-args` — `--policies
  wasm-compile-via-host`
- `tests/js/wasm-compile-via-host-policy.stdout`:
  ```
  routed: true
  compiled-mod: true
  pi: 314
  ```

## Suite result

Baseline: 29 pass, 0 fail, 0 err, 3 skip.
Final: **30 pass, 0 fail, 0 err, 3 skip.**
`wasm-compile-then` still passes.  No regressions.
`npx tsc --noEmit` exits 0.

## Perf delta

**Not measurable in this environment.**  Compiled a 3MB synthetic
wasm module (2000 fns × 500 ops each), 5 runs: with-policy avg
2.6ms, baseline avg 2.6ms.

Browser's `performance.now()` is clamped to 1ms under COOP/COEP —
the timer floor swallows any sub-ms difference.

Working hypothesis: edge's bundled V8 already delegates wasm compile
to host V8 via napi-host plumbing, so the "double-virtualization
tax" the policy was meant to eliminate doesn't actually exist on
this path in Chromium + JSPI.  The policy is functionally correct
but produces no observable perf win HERE.  May still matter for
deployments where edge's wasm V8 has its own compiled wasm sub-engine.

## Pitfalls (for future policy work)

1. **Intrinsics aren't `require()`-able** — can't use
   `builtinOverrides` for `WebAssembly`, `Atomics`, `Reflect`, etc.;
   use `userScriptPrelude`.
2. **`globalThis` is shared** between wasm-side and host — the
   snapshot is visible to user code (same as
   `compression-via-compressionstream`).
3. **`instanceof` works across the boundary** because edge freezes
   `WebAssembly.Module` but doesn't replace it.  If a future
   bootstrap layer polyfills the constructors, the policy would
   need per-instance proxies.
4. **`Date.now` / `performance.now` clamped under COOP/COEP** —
   sub-ms perf measurements need a different approach (op counts,
   throughput over fixed window, non-isolated probe).

## Recommendation

**Ship as opt-in.  Do not add to defaults.**  Functionally correct,
tests pass, zero suite regressions, zero cost when not enabled.  No
measurable perf win on current target (Chromium + edge's wasm V8)
means default-on is premature optimization.  Future-proof: flip on
by appending to `defaultBrowserPolicies` if/when a deployment shows
the perf delta in a real workload.

## Files changed in main

- `browser-target/src/host/globals-shim.ts` — `__edgeHostWebAssembly`
  snapshot
- `browser-target/src/policies/wasm-compile-via-host.ts` — new policy
- `browser-target/src/policies/index.ts` — exports + registers
- `tests/js/wasm-compile-via-host-policy.{js,harness-args,stdout}` —
  new test
