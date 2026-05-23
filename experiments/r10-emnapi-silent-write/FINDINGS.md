# R10: emnapi silent-write bug — research findings

**Date:** 2026-05-24
**Method:** Parallel research agents (R10a source archaeology + R10b
GitHub/community search) instead of more guess-and-check fix
iterations.

## The bug being researched

After R9's fix (open handle scope after `napiModule.init()`):
- ~4/10 ops verified end-to-end via host-RPC
- `napi_create_object`, `napi_create_int32`, `napi_create_date` work ✓
- `napi_create_array_with_length`, `napi_create_string_utf8` return
  status=0 (napi_ok) but WRITE NOTHING to memory at the result
  pointer ✗
- Same function reference (`sameRef=true`) — verified empirically
- Direct call from `ensureNapiContext()` synchronous context WORKS
- Same call from async RPC factory wrapper DOESN'T WRITE

## R10a — source archaeology verdict

**The bug is NOT in emnapi.**

Read the full call graph for working vs failing ops in
`@emnapi/core` v1.10.0 + `@emnapi/runtime` v1.10.0:

- Both ops do: `addToCurrentScope(value).id` →
  `new DataView(wasmMemory.buffer).setUint32(result, value, true)` →
  `return envObject.clearLastError()` (returns 0)
- `addToCurrentScope` → `currentScope.add(value)` →
  `handleStore.push(value); end++` — agnostic to value's runtime type
- `wasmMemory` captured exactly once at `napiModule.init()`; never
  reassigned within emnapi
- `clearLastError()` returns 0 unconditionally
- `checkGCAccess()` only throws under conditions that don't apply here
- The unprocessed `from64` macros found in the bundler dist are in
  a `/* ... */` block comment — not live code

**Verdict: identical static behavior. The discrepancy is a runtime
state issue OUTSIDE emnapi.**

## R10b — community/GitHub search verdict

**No matching upstream issue. Bug appears novel for emnapi.**

- Searched all 215 emnapi issues (open + closed)
- Searched npm changelog for `@emnapi/core` and `@emnapi/runtime`
- Searched web for the exact symptom
- v1.10.0 → v2.0.0-alpha.1 doesn't change these specific functions

**Strongest hypothesis from R10b** (matching R10a's runtime-state
recommendation):

> "If your factory wrapper unintentionally creates a second context
> (or holds a closure over a stale wasmMemory from a prior init),
> writes silently land in the wrong buffer. That matches the symptom
> precisely: same function ref, sync path works, async path writes
> to the wrong memory."

Reference: emnapi issue #96 — "If you have multiple emnapi modules,
you should reuse the same Context across them."

## Independent corroboration

During earlier instrumentation runs, the DIAG block (inside
`ensureNapiContext()`) appeared **twice** in the page log:

```
[host-worker:0] napi context ready; 151 napi fns available
... (DIAG block 1) ...
[host-worker:0] napi context ready; 151 napi fns available  ← TWICE
... (DIAG block 2) ...
```

But `ensureNapiContext()` has `if (napiCtx) return;` as its first
line. Two DIAG blocks means napiCtx was either:
(a) reset between calls (unlikely — no reassignment in code)
(b) Two separate module instances of host-worker.ts loaded
(c) Two host workers active

This corroborates the multi-context hypothesis.

## What's NOT yet verified

The hypothesis "factory captures stale wasmMemory reference" needs
empirical confirmation. R10a recommended the precise test:

> "Log the identity of `wasmMemory.buffer` in BOTH the sync-success
> path (DIAG inside ensureNapiContext) and the async-fail path (factory
> handler). If `wasmMemory` identity differs, the bug is multi-context.
> If scope identity differs, the bug is scope lifetime."

This requires runtime instrumentation we haven't yet added.

## Next-session plan (no more guessing)

1. **Confirm multi-context.** Find why DIAG runs twice. Suspects:
   - Vite HMR re-loading host-worker.ts module (dev-mode quirk)
   - Bridge worker re-firing "bridge-ready" (re-spawns host worker)
   - Browser worker spawn double-invocation (worker init race)
   - Add a `console.log("host-worker.ts MODULE LOAD")` at top of file
     to count actual module instantiations
2. **If multi-context confirmed:** fix by ensuring only ONE
   `ensureNapiContext()` ever runs (stronger init guard, or move init
   to module top-level, or capture the `wasmMemory` identity and
   reject duplicate inits).
3. **If single context:** the bug is scope-lifetime or buffer-detach
   — different fix path; instrument scope state at both call sites.

## Files / sources

- `/Users/robertpolana/etc/projects/edgejs/browser-target/node_modules/@emnapi/core/dist/emnapi-core.mjs`
- `/Users/robertpolana/etc/projects/edgejs/browser-target/node_modules/@emnapi/runtime/dist/emnapi.mjs`
- emnapi issue #96 — multiple emnapi modules binding
- emnapi getting-started docs — `getDefaultContext` recommendation
- F-9 sweep probe state at commit `c7520195` (4/10 ops pass)

## Status for path-(a)

**Bug isolated to runtime state outside emnapi.** Specific hypothesis
identified with two converging research paths. Empirical confirmation
needed but well-scoped — not blocked on architecture or unknown
behavior.
