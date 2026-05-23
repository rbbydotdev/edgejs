# R7: synthetic napi_callback_info — findings

**Date:** 2026-05-23
**Result:** PASS — Strategy C works end-to-end with real emnapi v1.
~1.02 µs per synthesis; clean re-entrancy to depth 8; no scope leaks.

## The question

When the wasm-side reverse-RPC handler invokes a NAPI_CALLBACK-shape
funcref via `wasmTable.get(cbPtr)`, the funcref expects an opaque
`napi_callback_info` handle as its second arg. Inside the funcref,
emnapi's `napi_get_cb_info(env, cbinfo, ...)` resolves cbinfo back to
{argc, argv, thisArg, data}. How do we construct a valid cbinfo so
the funcref can unpack its args?

## Strategy survey

**A. Manual struct in linear memory — REJECTED.** No native struct
exists. `cbinfo` is a JS-side scope ID; `napi_get_cb_info` routes
through `emnapiCtx.getCallbackInfo(cbinfo)` →
`_scopeStore.deref(info).callbackInfo`
(`vendor/emnapi/packages/runtime/src/Isolate.ts:201-203`). The
CallbackInfo is a JS object hung off `HandleScope.callbackInfo`
(`runtime/src/HandleScope.ts:21,36-43`). Nothing to mirror in memory.

**B. Exported allocator — REJECTED.** Grep across
`vendor/emnapi/packages/{emnapi,core,runtime}/src/` finds no
`*alloc*callback_info*` or `*create*callback_info*` export. The
only path that populates a CallbackInfo is the private `withScope`
helper inside `createFunction` (`Context.ts:29-45`), not exposed
externally.

**C. Open scope + mutate `callbackInfo` directly — ACCEPTED.** This
mirrors exactly what emnapi's internal `withScope` does — lifted out
and called manually. Proof: `Context.ts:292-294`, where emnapi's
dynamically-built function wrapper passes `ctx.getCurrentScope()!.id`
as cbinfo. **`scope.id` IS the cbinfo handle.**

## Empirical validation

Probe boots a real `@emnapi/runtime` + `@emnapi/core` context (same
wiring as `host-worker.ts:111-150`), hand-builds a NAPI_CALLBACK
funcref that calls `napi_get_cb_info` via the public C ABI through
`napiModule.imports.napi`. Six round-trip assertions PASS:

- `argc` → 2 ✓
- `args[0]` → 42 ✓ (int32)
- `args[1]` → "hello" ✓ (string)
- `this` → same JS object identity ✓
- `data` → 0xdeadbeef ✓ (raw u32)
- return-value handle dereferenced inside scope → 7 ✓

Re-entrancy: callback recursively calls itself to depth 8, each
level synthesizes its own cbinfo. All eight levels see correct
argc/args — no cross-scope contamination.
`ScopeStore.openScope` (`runtime/src/ScopeStore.ts:15-28`) handles
nested scope reuse correctly.

## Per-call latency

10,000 iterations of full path (openScope → set 5 fields → invoke
funcref → funcref's `napi_get_cb_info` + 4 output derefs → closeScope):

**1019 ns ≈ 1.02 µs/call.**

E4's end-to-end reverse-RPC roundtrip is ~31 µs median.
**Synthesis = ~3.3% of end-to-end budget. Negligible.**

## Integration spec

Replace the `cbinfo=0` shortcut at `callback-dispatch.ts:312-323`.
Two new fields on `RegisterWasmCallbackInvokerOptions`:

```ts
export interface RegisterWasmCallbackInvokerOptions {
  wasmTable: WebAssembly.Table;
  depthCounter: { depth: number };
  wasmCtx: Context;   // NEW: wasm-side emnapi context
  wasmEnv: Env;       // NEW: wasm-side env (via wasmCtx.getEnv(envId))
  maxDepth?: number;
}
```

NAPI_CALLBACK case body:

```ts
case CALLBACK_SHAPE_NAPI_CALLBACK: {
  const scope = wasmCtx.openScope(wasmEnv);
  const cbi = scope.callbackInfo;
  cbi.args = argv.map((h) => wasmCtx.jsValueFromNapiValue(h));
  cbi.thiz = undefined;          // see R8 caveat — thisArg via marshaling
  cbi.data = dataPtr;
  cbi.fn = fn;                   // non-zero so dispose() tears down
  cbi.holder = undefined;
  try {
    const ret = (fn as (env: number, info: number) => number)
      .call(undefined, env, scope.id);
    returnHandle = (typeof ret === "number" ? ret : 0) >>> 0;
  } finally {
    wasmCtx.closeScope(wasmEnv, scope);
  }
  break;
}
```

Wiring delta in `worker.ts:625-638`: plumb worker's emnapi context +
env into `registerWasmCallbackInvoker`, likely via a small accessor
on `napi-host/index.ts`.

## What R7 does NOT cover (R8 territory)

1. **Cross-context handle marshaling for argv & return value.** The
   probe used ONE emnapi context; production has TWO (host's emnapi
   + wasm's emnapi). Handle ID 14 in host context refers to a
   different JS value than handle ID 14 in wasm context. The
   integration commit must address this — likely a serializer at the
   marshaling boundary (primitives directly, objects via shared
   identity map). **R7's synthesis primitive works regardless; the
   marshaling story is the separate unsolved problem.**

2. **Return-handle lifetime.** Funcref's return is allocated inside
   the synthesized scope and dies on `closeScope()`. The reverse-RPC
   reply carries the u32 but it's stale by reply-receipt time.
   Cleanest fix: dereference inside scope, serialize the JS value,
   re-handle on host. Same boundary as caveat 1.

3. **`thisArg` is undefined** in the integration template. Fine for
   `napi_create_function` (callees typically don't use `this`), but
   `napi_define_class` needs it (constructor sees `this` = new
   instance). Add `thisArgHandle` to the reverse-RPC request payload
   before shipping define_class.

4. **CLEANUP_HOOK & FINALIZER shapes don't need this.** Direct
   argument-passing; existing code at `callback-dispatch.ts:324-343`
   is already correct.

5. **Scope reuse** — `ScopeStore.openScope` reuses prior child scope
   objects, so `callbackInfo` fields may be stale. Always set all
   five fields before invoking; the template above does.

## Status for path-(a)

**R7's synthesis primitive: risk retired, 1 µs cost, integration
template ready.**

**R8 cross-context marshaling: NEW unknown surfaced by R7.** The
last 2 ops need this resolved before they can ship. Probably "small
spike" not "show-stopper" but it's empirically unvalidated.

**Recommended sequencing for the final integration:**

1. **R8 spike** — empirical probe of cross-context value marshaling.
   Primitives, strings, objects, arrays. Time the serializer.
2. **cbinfo integration** — land R7's synthesis behind a flag,
   covering the trivial-args case (argc=0, no thisArg). Unblocks
   the simplest `napi_create_function` usage; proves the wiring
   end-to-end.
3. **Argv + thisArg marshaling** — on top of R8.
4. **`napi_define_class`** — needs thisArg machinery from (3).

## Key file:line citations

- `vendor/emnapi/packages/emnapi/src/function.ts:33-75` — `napi_get_cb_info` impl
- `vendor/emnapi/packages/runtime/src/Isolate.ts:201-203` — `getCallbackInfo` → scope deref
- `vendor/emnapi/packages/runtime/src/HandleScope.ts:21,36-43,60-71` — `callbackInfo` field + dispose
- `vendor/emnapi/packages/runtime/src/Context.ts:29-45` — `withScope` (the pattern we mirror)
- `vendor/emnapi/packages/runtime/src/Context.ts:281-326` — `createFunction`
- `vendor/emnapi/packages/runtime/src/Context.ts:292-294` — `scope.id` IS the cbinfo
- `vendor/emnapi/packages/runtime/src/ScopeStore.ts:15-28` — scope nesting/reuse
- `browser-target/src/host-worker/callback-dispatch.ts:300-323` — current `#!~debt` location
- `experiments/r7-cbinfo-synthesis/probe.mjs` — empirical validation
