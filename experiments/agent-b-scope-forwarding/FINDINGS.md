# Agent B: wasm-side scope-op forwarding (host-emnapi-root-scope fix)

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a52bf30f1efd129cb`
**Result:** Shipped.  TS-only, no wasm rebuild.  Suite: 37/0/3 → 39/0/3
(+1 from scope-forwarding-bounded test integrated alongside Agent C's
test which also landed in this commit batch — both integrated together).

## Implementation

3 new RPC ops:
- `OP_NAPI_OPEN_HANDLE_SCOPE = OP_DOMAIN_NAPI_RO | 0x00D0`
- `OP_NAPI_CLOSE_HANDLE_SCOPE = OP_DOMAIN_NAPI_RO | 0x00D1`
- `OP_NAPI_DEBUG_HANDLE_STORE_SIZE = OP_DOMAIN_NAPI_RO | 0x00D2` (probe)

**Host handlers** (host-worker.ts): open calls `napiCtx.openScope(env)`,
stores in `Map<scopeId, Scope>`, returns scope id.  Close looks up,
calls `napiCtx.closeScope(env, scope)` — releases every handle
allocated during that scope's lifetime via `handleStore.erase(start,
end)`.  Debug returns the live-handle count.

**Wasm-side wrappers** (worker.ts): wrap `napi_open_handle_scope` /
`napi_close_handle_scope` on the napi imports after `createNapiHost`,
before splitting them into the wasm namespaces.  On open: call the
original emnapi impl (returns wasm-side scope id), then fire
`hostRpcSyncClient.callSync(OP_NAPI_OPEN_HANDLE_SCOPE, ...)`, store
`wasmScopeId → hostScopeId` map.  On close: pull host id from map,
fire `OP_NAPI_CLOSE_HANDLE_SCOPE`, delete map entry.

Null-checked against `hostRpcSyncClient` so bootstrap-order races
degrade gracefully.

## Validation

**Direct probe** (`probe-scope-bounded.mjs`, `?probe=scope-bounded`)
drives the host handlers from the page directly:
```
baseline=6 afterScoped=6 afterUnscoped=1006
totalAllocs=1000 scopedGrowth=0 unscopedGrowth=1000
OK (scoped <= 26 ? true; unscoped >= 500 ? true)
```

- 200 iters of `(OPEN, 5×CREATE_OBJECT, CLOSE)` → **0 net growth** over
  1000 allocs
- 200 iters of `(5×CREATE_OBJECT, no scope wrap)` → **+1000 growth**

Proves the leak exists without the fix (test isn't vacuously passing).

**Integration test** `tests/js/scope-forwarding-bounded.js`: 200-iter
crypto hash loop, asserts no regression in wasm boot + napi path under
wrapping.

## Edge cases handled

- **Bootstrap order**: wrappers null-check `hostRpcSyncClient`; if RPC
  SAB not yet wired, wasm side still gets a valid scope.
- **Out-of-order close**: host handler tolerates missing map entries
  (emnapi's `HandleScope.dispose` is idempotent).
- **Stale wasm scope id**: map entry deleted BEFORE the host RPC fires,
  so duplicate close on host can't happen.
- **Env id namespaces**: wasm-side env and host env live in different
  namespaces.  Host always has env id=1 (per ensureNapiContext's stub
  `emnapi_create_env`), so wasm-side env id isn't wired through.
  Multi-env host would add `envId→hostEnvId` map; not needed today.
- **emnapi v1 vs v2**: `DEBUG_HANDLE_STORE_SIZE` falls back across
  `_next` (npm 1.10) and `_allocator.next` (vendored v2).

## Per E7's earlier finding: dormant infrastructure today

Today's edge.js wasm never calls `napi_open_handle_scope` from the
wasm side (0 calls / 18 wasm-routed tests per E7).  The wasm-side
wrappers are **dormant infrastructure** that fires the moment
worker_threads phase 1 ships or the F-7 cutover routes wasm-local
napi_* through host-RPC.

Until then, the host root-scope leak persists for real edge.js
workloads; only the synthetic probe exercises the new path.  **This
is the intended posture — infrastructure ready, no fix-during-
cutover delay.**

## Open items / debt

1. `napi_open_escapable_handle_scope` not wired — same shape but
   requires escape() bookkeeping.  No workload exercises it today.
2. No suite-side coverage of the leak ITSELF (the probe asserts
   bounded growth via direct RPC, not via a wasm-driven workload).

## Integration merge

B was forked before C (E22-C, Hmac napi-mem) was integrated.  C's
changes to `worker.ts` overlapped with B's wasm-side wrapper additions
(both modified the napi imports import line).  Resolved via
`git apply --3way` then manual merge of one conflict line in the
imports — combining both ops in a single import statement.

## Files changed in main

- `browser-target/src/host-worker/rpc-protocol.ts` — 3 new op codes
- `browser-target/src/host-worker/host-worker.ts` — 3 handlers
- `browser-target/src/worker.ts` — wasm-side scope-op wrappers
- `browser-target/src/main.ts` — `runScopeBoundedProbe`
- `browser-target/scripts/probe-scope-bounded.mjs` — new
- `tests/js/scope-forwarding-bounded.{js,harness-args,stdout}` — new
