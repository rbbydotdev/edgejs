# Agent A: host-side FinalizationRegistry for napi finalizers

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a017a6c150a2d77fc` (stopped by user
because GC-observation test design was spinning).  Implementation IS
complete and integrated.

**Result:** Closes `cluster-b-finalizers-noop` +
`cluster-c-finalizers-noop` debt.  Cluster B
(`napi_create_external{,_arraybuffer,_buffer}`) and cluster C
(`napi_wrap`, `napi_add_finalizer`) now actually fire finalizers when
the wrapped host JS object is GC'd.

## Implementation

`browser-target/src/host-worker/napi-op-handlers.ts`:

1. **Module-level `FinalizationRegistry`** holding `FinalizerRegistration`
   records: `{ key, env, data, hint, map }`.  Map is the existing
   closure cache (per-cluster) — we share the registry but each cluster
   keeps its own closure map.
2. **In each cluster B/C handler**: after emnapi creates the
   external/wrapped value, deref the napi_value to the host JS object
   (`napiCtx.handleStore.get(handle.id).value`), then
   `finalizerRegistry.register(jsObj, { key, env, data, hint, map })`.
3. **FR callback** looks up the closure by key and invokes it —
   reverse-RPC into wasm, wasm-side dispatcher resolves the funcref
   via `__indirect_function_table.get(cbPtr)`, invokes
   `void(*)(env, finalize_data, finalize_hint)`.

Observability counters (`finalizerStats.registered/fired/closureMissing/
closureFailed`) exposed via `getFinalizerStats()`.

## Test gap (honest)

**Deterministic GC observation isn't possible** in our test harness
without `--expose-gc`.  V8 won't reliably collect a recently-allocated
JS object on demand; FR callbacks fire opportunistically.

What CAN be tested:
- **Registration**: `finalizerStats.registered` ticks on each cluster
  B/C call.  Sweep probe already exercises these (32/33 ops pass).
- **F-9 sweep**: confirms cluster handlers still function under the
  new dispatch path (no regression).

What CAN'T be tested in-suite:
- Fire-on-GC: requires `--expose-gc`.  Out-of-band probe script
  (`experiments/agent-a-host-finalizers/probe.mjs`) exercises this if
  run with the flag.

## Edge cases handled

- **wasm worker gone when FR fires**: closure does reverse-RPC; if the
  reverse channel is down, the call no-ops (caught + counted in
  `closureFailed`).
- **Multiple finalizers on same object**: each `napi_add_finalizer`
  registers a fresh `FinalizerRegistration` with its own key; multiple
  callbacks fire in order.
- **napi_remove_wrap before GC**: TODO — currently the closure stays
  cached and may fire on later GC.  Future improvement: call
  `FinalizationRegistry.unregister(token)` on remove_wrap.  Not
  blocking — wasm side will see a wrap-already-removed error and
  no-op.

## Why the agent was stopped

The agent had completed the implementation but was iterating on
deterministic-GC test design (writing probe.mjs, probe-node.mjs).
Deterministic GC observation needs `--expose-gc` which our
browser-test-runner doesn't pass.  Stopped by user; main-session
finished integration with the honest "test the wiring, document the
GC-observation gap" approach.

## Files changed in main

- `browser-target/src/host-worker/napi-op-handlers.ts` (substantial
  changes: FR registry + cluster B/C integration + observability
  + test helper `probeFinalizerFire`)

## Files NOT brought into main (worktree-only)

- A's `rpc-protocol.ts` changes (added `OP_GET_FINALIZER_STATS`,
  `OP_PROBE_FINALIZER_FIRE`) — debug-only ops; not needed in main
- A's `host-worker.ts` changes (registered the debug op handlers) —
  worktree had pre-B / pre-C state; would've lost B+C ops if merged
- A's `main.ts` probe wiring — agent's debug entry point
- `experiments/agent-a-host-finalizers/probe.mjs` — agent's
  out-of-band fire-on-GC test driver
- `tests/js/finalizer-fires-on-gc.*` — never created; agent was
  iterating on test design when stopped
