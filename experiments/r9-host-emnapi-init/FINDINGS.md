# R9: host emnapi init bug — findings

**Date:** 2026-05-24
**Result:** Bug reproduced; root cause + minimum-diff fix identified.
F-9 sweep probe's `create_*` failures are a latent init bug, not a
recent regression.  Fix is one `napi_open_handle_scope` call after
`napiModuleHost.init()`.

## The diagnosis

`napiModule.init()` in `@emnapi/core` v1.10.0 opens a scope around
its internal `napi_register_wasm_v1` registration call
(`emnapi-core.esm-bundler.js:157`) and **closes it again in the
finally block at line 173**.  After init returns,
`ctx.scopeStore.currentScope` reverts to the root scope (id=0,
`handleStore=null`).

The first call to any handle-allocating napi op
(`napi_create_object`, `_int32`, `_string_utf8`, …) executes:

```
napi_create_object → emnapiCtx.addToCurrentScope(value)
  → currentScope.add(value)
  → currentScope.handleStore.push(value)   ← TypeError: handleStore is null
```

This throws synchronously.  In production:
- `rpc-server.ts:123` catches the throw → replies with
  `REPLY_STATUS_HOST_ERROR=4` (matches one F-9-probe status)
- The throw also sets `envObject.lastError`, so subsequent napi
  calls return `napi_pending_exception=10` (matches the other)

Fully explains the F-9 sweep failure pattern.

## Why F-1 passed but F-9 didn't

`napi_get_undefined/null/global` (F-1) don't allocate handles —
they write `GlobalHandle` constants directly to memory.  F-1
passed even with `handleStore=null`.

`napi_create_*` (F-9) DO allocate handles.  F-9 was the first ops
batch to exercise the broken path.  **It is not a regression from
any recent change; it's an init bug that's been latent since the
host-side emnapi context was wired up at F-1.**

## Empirical evidence

Without `napi_open_handle_scope`:

```
napi_get_undefined  status=0 mem=1                    (works — constant write)
napi_get_null       status=0 mem=2                    (works — constant write)
napi_get_global     status=0 mem=5                    (works — constant write)
napi_create_object  THREW: TypeError: Cannot read properties of null (reading 'push')
napi_create_int32   THREW: Cannot read properties of null (reading 'push')
napi_create_string  THREW: Cannot read properties of null (reading 'push')
```

After adding `napi_open_handle_scope(1, ptr)` once after init:

```
napi_get_undefined  status=0 mem=1
napi_get_null       status=0 mem=2
napi_get_global     status=0 mem=5
napi_create_object  status=0 handle=6
napi_create_int32   status=0 handle=7
napi_create_string  status=0 handle=8
napi_typeof(object) status=0 typeof=6   (napi_object — correct)
napi_typeof(GLOBAL) status=0 typeof=6   (napi_object — correct)
```

## Minimum-diff fix

In `host-worker.ts` `ensureNapiContext()` after `napiModuleHost.init(...)`:

```ts
// emnapi's init() opens a scope internally for napi_register_wasm_v1
// and closes it again.  After init, currentScope reverts to root
// (id=0, handleStore=null), so any napi op that allocates a handle
// (create_object, create_int32, create_string_utf8, …) throws on
// `currentScope.handleStore.push(value)`.  Open a long-lived scope
// here so handle-allocating ops work.  Pattern matches every
// experiment that successfully drives host emnapi (R7, R8).
const SCOPE_OUT_PTR = 1020; // reserved below the 16K malloc pool
const scopeStatus = (
  napiModuleHost.imports.napi!.napi_open_handle_scope as
    (env: number, ptr: number) => number
)(1, SCOPE_OUT_PTR);
if (scopeStatus !== 0) {
  throw new Error(`host emnapi init: napi_open_handle_scope failed: ${scopeStatus}`);
}
```

## Reference experiments that DO it right

- `experiments/r7-cbinfo-synthesis/probe.mjs:128` — opens scope after init
- `experiments/r8-cross-context-marshaling/probe.mjs:80` — same
- `experiments/l5-real-roundtrip/probe.mjs` — does NOT open one,
  because it only tests constant-write ops (UNDEFINED/NULL/GLOBAL),
  matching the F-1 limitation exactly.  This is how the bug went
  unnoticed at F-1 time.

## After-fix verification

All of `napi_create_object`, `napi_create_int32`,
`napi_create_string_utf8`, `napi_create_array_with_length`,
`napi_typeof` (on both globals and freshly-created handles) return
status=0 with non-zero handle IDs.  Verified empirically in
EXPERIMENT 2 and 3b of the probe.

## Important caveat — `napi_get_null=0` is a DIFFERENT bug

The `probe-f9-sweep.mjs` reported `napi_get_null=0` (should be 2).
This symptom did NOT reproduce in R9's isolation — `napi_get_null`
correctly writes 2 at all 8 result-pointer addresses tested.

That part of the F-9 sweep diagnostic is **misleading**; the bug is
elsewhere (SAB-RPC plumbing, or stale memory read in the sweep
itself), not in host emnapi init.  Worth a separate one-off probe.

## Production caveats

1. **The fix opens a root scope and never closes it.**  Handles
   accumulate.  Fine for short-lived test runs; for long-running
   production hosts processing many handle-allocating RPCs, refactor
   `makeNapiTwoArgHandler` and the bulk registry in
   `napi-op-handlers.ts` to open/close a scope per RPC call.  That's
   the production-clean version; the one-line fix above is the
   minimum viable patch.
2. **`EDGE_USE_VENDORED_EMNAPI` is OFF by default** so
   `node_modules` (v1.10.0) is what's loaded.  Vendored is
   v2.0.0-alpha.1 with DIFFERENT `GlobalHandle` constants
   (UNDEFINED=2, NULL=3, GLOBAL=6).  If the flag is ever flipped on,
   F-1 expected values need updating.

## Files

- `experiments/r9-host-emnapi-init/probe.mjs` — runnable probe (6 experiments)
- `experiments/r9-host-emnapi-init/package.json` — pins to v1.10.0
- Fix target: `browser-target/src/host-worker/host-worker.ts:149`
