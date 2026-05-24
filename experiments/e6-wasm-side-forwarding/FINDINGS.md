# E6: wasm-side forwarding spike — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-aa90b4e9582324f8a` (port 5181)
**Result:** Pattern B (Proxy on `napi.imports.napi`) is the better of
two interception patterns; per-call delta is negligible.  Forwarding
adds **40-55× in-process cost** (~18-25 µs absolute) — uniform across
ops because the cost is in RPC plumbing, not the handler.  Forwarding
must be **gated by an explicit opt-in allow-list**, defaulting empty.

## The question

F-9 wired all 106 napi op handlers on the host worker.  None of them
fire under real workloads — the wasm-side napi-host shim
(`browser-target/src/napi-host/`) does not forward any op via RPC.

To make F-9's host-tier reachable from real edge.js code we need a
wasm-side intercept layer.  Two candidate patterns:

  (A) Per-op factory wrap — mutate each forwarded import at setup.
  (B) Proxy on `napi.imports.napi` — single mutation, op-list as data.

Which is better, and what's the per-call cost?

## Methodology

A page-side probe (`runE6WasmForwardProbe`, gated on
`?probe=e6-wasm-forward`) replicates `host-worker.ts:ensureNapiContext`
to build a local in-process emnapi context, then runs four 1000-iter
loops:

1. In-process baseline — direct `napi.napi_create_object(env, ptr)`
2. RPC direct — `RpcClient.call(OP_NAPI_CREATE_OBJECT, ...)` to the
   existing host worker handler
3. Pattern A — closure-wrap on `napiNs.napi_create_object`
4. Pattern B — `Proxy` get-trap on `napi.imports.napi`

200-iter warmup; 3 runs; median + p99 reported.  All 25 expected-pass
tests + F-1 probe + F-9 sweep verified untouched.

## Measured latencies

| Path                       | per-call (µs) | median (ms) | p99 (ms)    |
|----------------------------|---------------|-------------|-------------|
| in-process baseline        | 0.38 – 0.60   | 0.000       | 0.005       |
| RPC direct (async)         | 18.1 – 24.9   | 0.015-0.020 | 0.085-0.135 |
| Pattern A (closure wrap)   | 18.4 – 33.5   | —           | —           |
| Pattern B (Proxy)          | 19.6 – 31.0   | —           | —           |

**Ratio: RPC ≈ 40-55× in-process.  Absolute extra: ~18-25 µs/call.**

The cost is uniform because it's in the RPC plumbing (slot claim,
header write, Atomics.wait/notify, drainer, dispatch, reply, decode),
not the handler — handler is sub-µs.

## Pattern comparison

| | Pattern A (closure) | Pattern B (Proxy) |
|---|---|---|
| Mutation points | O(106) at setup | 1 |
| Op-list representation | per-import installs | `Set<string>` data |
| Per-call overhead | direct call | ~0.3 µs trap tax (in cases JS re-reads namespace; usually amortized to instantiate-time) |
| Forgotten ops | silently in-proc | explicit, list-driven |

**Selected: Pattern B.**  The per-call delta is negligible (~0.3 µs)
against the RPC roundtrip (~20 µs).  The maintenance win (single
data-driven list across 106 ops) dominates.

## Scaling estimate

The ~20 µs/call is uniform.  Naive forwarding of all 106 host-wired
ops would add:

| Workload          | Ops    | In-proc | Forwarded | Slowdown |
|-------------------|--------|---------|-----------|----------|
| `_start` cold     | ~30k   | ~15 ms  | ~600 ms   | 40×      |
| Per HTTP request  | ~200   | ~0.1 ms | ~4 ms     | 40×      |
| Hot loop ops/sec  | ~10k   | ~5 ms   | ~200 ms   | 40×      |

Naive "forward everything" is not viable.

## Recommendation

Ship Pattern B with `forwardedNapiOps: Set<string>` option on
`createNapiHost`, default empty (opt-in per deployment).  Initial
cold-path candidates that amortize over many later calls:

- `napi_run_script` — one-shot per builtin compile
- `napi_create_function`, `napi_define_class` — function mint
- `unofficial_napi_*` — we own the impl; forwarding clarifies the
  multi-context F-8 story

**Hot-path ops MUST NOT be forwarded** without one of:
1. Bundled-args batches (E1's territory)
2. Wasm-side memoization (short-circuit well-known values)
3. Co-located fast path (don't move what doesn't need moving)

The gating mechanism is one option field + one Proxy install, all in
`napi-host/index.ts` — small, surgical, reversible.

## Compatibility

- `probe:f1-napi`: PASS (7/7 ops)
- `probe:f9-sweep`: PASS (29/30 — pre-existing `create_external_arraybuffer`
  arg-validity gap, unrelated to spike)
- `npx tsc --noEmit`: clean
- Spike is additive + URL-flag gated; doesn't affect non-probe paths

## Open questions for follow-up

- Real per-RPC cost may improve with R6a's shared-wake batching if
  multiple forwarded calls happen in a tight window — not measured here.
- Forwarding `napi_run_script` would touch the L5 user-script story
  (already runs on host via `OP_RUN_USER_SCRIPT`); needs reconciliation.
- The Proxy install must occur AFTER `napiModule.init` because emnapi
  reads imports at instantiate-time — verified working in spike but
  documenting the ordering constraint.

## Code (worktree, not merged)

- Spike: `browser-target/src/main.ts` (`runE6WasmForwardProbe`,
  URL-flag handling, early-return in `spawnHostThenRuntime` when
  probe selected)
- Driver: `experiments/e6-wasm-side-forwarding/probe.mjs`
- Port: `_runner-common.mjs` VITE_PORT 5173→5181
