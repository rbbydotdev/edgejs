# L5 emnapi v2 experiment — findings

**Date:** 2026-05-23
**Branch state:** committed in experiments/l5-emnapi-v2/

## Conclusion

**emnapi v2 supports our split-worker topology with concrete, validated
plumbing.**  We don't need to fork or patch emnapi for the foundational
piece; we use it as designed.  The work shifts to (a) writing the
wasm-side stubs that RPC to host, and (b) glueing the shared-memory
model end-to-end.

## What probe 1 proved (`probe.mjs`)

- `createContext()` + `createNapiModule({context, childThread:false})`
  works.
- The resulting `napiModule.imports.napi` contains **141 napi functions**.
- `imports.env` has 34 emnapi-internal helpers.
- `imports.emnapi` has 11 emnapi-namespace functions.
- All accessible from regular JS — no emscripten special context
  needed for the runtime-side.

## What probe 2 proved (`probe-rpc-wrap.mjs`)

- Each napi function in `imports.napi` is wrappable in a JS proxy that
  intercepts the call.
- Bad arguments (env=0) return a status code, no crashes.
- Call counts can be tracked for diagnostics.

## What probe 3 proved (`probe-with-memory.mjs`)

The critical probe.  Set up:
- **Real `WebAssembly.Memory`** with `shared: true`
- **Stub wasm instance** with required exports (memory, malloc, free,
  emnapi_create_env, napi_register_wasm_v1)
- **emnapi host context** initialized against the stub via
  `napiModule.init({instance, module, memory, table})`
- Called `napi.napi_get_undefined(env=1, resultPtr=2048)`

Result:
```
napi_get_undefined status: 0
wrote handle id at memory[2048]: 2
```

The host-side emnapi function **read the result_ptr argument, wrote
the handle id directly into the shared memory at that address**.  In
production: that memory is the wasm worker's linear memory.  Both
workers see the same bytes.

## The split-worker pattern, concretely

```
Wasm worker:                          Host worker:
  ┌──────────────────────┐              ┌──────────────────────────┐
  │ wasm.Instance         │              │ emnapi Context           │
  │  exports.memory ──────│──── SAB ─────│──► napiModule.init       │
  │  exports.malloc       │              │      ({instance: stub})  │
  │  napi imports:        │              │ napiModule.imports.napi  │
  │    napi_get_undefined │              │   (141 host-side fns)    │
  │      = RPC stub ──────│─ SAB-RPC ───►│   napi_get_undefined()   │
  │                       │              │   ↑ writes handle id     │
  │                       │◄── SAB ──────│     to SHARED memory     │
  │  (status returned     │              │                          │
  │   via RPC reply)      │              │                          │
  └──────────────────────┘              └──────────────────────────┘
```

For each napi call from wasm:
1. Wasm worker calls its imported `napi_<op>` (which is an RPC stub).
2. Stub serializes args to the SAB request ring.
3. Host's RPC server receives, calls `hostModule.imports.napi[op](...args)`.
4. Host's napi function reads/writes the **shared memory** for args + results.
5. Status code returns via SAB reply ring.

## What's validated; what's open

| Concern | Probe verdict | Notes |
|---|---|---|
| emnapi v2 createContext/createNapiModule API | ✅ works | direct usage, no patch needed |
| 141 napi functions accessible | ✅ confirmed | enough surface for Node compat |
| napi functions can write to wasm memory | ✅ confirmed | via shared `WebAssembly.Memory` |
| Init requires a real `WebAssembly.Module` | ⚠️ small constraint | trivial empty Module works; production uses the real one |
| Init requires `napi_register_wasm_v1` export | ⚠️ wasm side | edge.js's wasm exports this already (or we stub) |
| malloc/free re-entrancy | ❓ untested | host's emnapi calls `exports.malloc` for some ops; if wasm is blocked waiting for the napi reply, this could deadlock.  Needs design. |
| Threadsafe functions | ❓ untested | requires reverse-channel; we have it from L4. |
| Real wasm calling real napi | ❓ untested in experiment | next step — wire to a tiny native addon. |
| Performance | ❓ untested | L3 measured 22μs per RPC; should hold. |

## The malloc re-entrancy question

When host's emnapi calls `_malloc(size)`, that's the wasm worker's
malloc export.  In our split-worker world, the host's malloc is an
RPC stub → wasm worker → wasm exec → return ptr.

But the wasm worker is BLOCKED at this point waiting for the napi
call to return.  If host RPCs back to wasm for malloc, the wasm
worker can't service it because it's in `Atomics.wait`.

**DEADLOCK.**

Resolutions (designed, not implemented):

1. **Pre-allocate a bump pool**: wasm allocates a memory region at
   boot; host's "malloc" parcels it out without RPCing.  Simple but
   leaks until process end.
2. **Worker pool**: a separate "memory worker" services malloc/free.
   Wasm worker isn't involved in malloc.  More workers, more setup.
3. **Coroutine wasm**: wasm export `malloc` runs in a side context that
   can interrupt napi calls (Asyncify-style).  Heavy.
4. **Defer malloc-needing ops**: napi ops that need malloc (mostly
   `napi_create_arraybuffer`) are routed differently.  Wasm side
   pre-allocates, sends ptr in the request.

For L5 minimum (closing the microtask regression), we don't need any
napi ops that malloc.  We can DEFER this until it bites.

## Recommended path forward

Based on these findings, **Option F is feasible and is what we should
do.**  Detailed plan:

### Phase F-1 — RPC plumbing (1 week)

1. Build a wasm-side "napi proxy" module that wraps each of the 141
   napi functions in an RPC stub.  Reuse our L2-L4 SAB-RPC primitives.
2. Build a host-side "napi RPC server" that receives the RPC and
   dispatches to `hostModule.imports.napi[opName]`.
3. Add a wasm-side handshake at boot: wasm imports the proxy stubs
   instead of edge.js's current in-process napi-host code.

### Phase F-2 — Memory bridging (3 days)

1. Wasm worker creates a shared `WebAssembly.Memory` at instantiation.
2. Posts the memory object (or its SAB) to the host worker.
3. Host's emnapi context gets that memory.
4. All napi reads/writes use the shared memory directly.

### Phase F-3 — `napi_register_wasm_v1` + env setup (2 days)

1. Wasm exports `napi_register_wasm_v1` (edge.js already does).
2. At boot, host calls this via RPC to register the wasm addon's exports.
3. Env creation: host's `emnapi_create_env` proxy RPCs wasm; wasm runs
   the real export; returns env id.

### Phase F-4 — exercise via tests (3 days)

1. Un-skip `microtask-before-timer.js` and friends — should pass once
   user JS runs on host V8 + napi RPCs to host context.
2. Wire `console.log` end-to-end (the simplest user-facing napi path).
3. Iterate on whichever real tests reveal real bugs.

### Phase F-5 — malloc resolution (open scope, defer)

When we hit the first napi op that mallocs, implement option (1) or (4)
from the deadlock-resolution list.  Until then, restrict the active
napi ops.

## Total estimate

**Phases F-1 through F-4: ~2.5 weeks.**  This closes the microtask
regression and gives us the foundation to run real Node apps (with the
malloc-dependent ops degraded until F-5).

This is markedly better than the original Option A estimate (2-4 weeks
all-or-nothing with no validation until the end).  F is incrementally
testable: each phase has a clear deliverable + diff-test point.

## Files in this experiment

- `package.json` — references vendored emnapi v2
- `probe.mjs` — basic API surface verification
- `probe-rpc-wrap.mjs` — proxy wrapping pattern
- `probe-with-memory.mjs` — full call through with shared memory
- `FINDINGS.md` — this document
