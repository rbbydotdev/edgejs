# R8: cross-context napi_value marshaling — findings

**Date:** 2026-05-24
**Result:** PASS — Strategy 3 (hybrid) works end-to-end with two
independent real emnapi contexts.  Per-call marshaling ~0.5-1.4 µs
single-arg, ~1.9 µs for a typical 4-arg argv.  Identity preserved
across calls; identity map deduplicates correctly.  R7 caveat #1
retired.

## The question

R7 retired the cbinfo synthesis primitive but surfaced caveat #1:
production has TWO independent emnapi contexts.

- `hostCtx` lives on the host worker — drives the 104 ops migrated
  by F-9.
- `wasmCtx` lives on the wasm runtime worker — drives edge.js's
  wasm.

**Handle ID 14 in `hostCtx` is not the same value as handle ID 14
in `wasmCtx`.**  `makeHostSideCallbackClosure`
(`callback-dispatch.ts:178-182`) currently bundles raw u32 host
handles as if the wasm side could deref them — it can't.  Same
problem on the return path.

## Independence confirmed empirically

Probe boots two contexts via `createContext()` + `createNapiModule()`
+ `napiModule.init()` exactly as production does.  Confirmed
independent: host minted `'HOST-ONLY-STRING-12345'` at id=8; wasm
deref of the same id = `{}`.

## Strategy outcome

**Strategy 3 (hybrid) is the right answer.**

- Strategy 1 alone (primitives inline) covers numbers/strings/bools
  but loses object support.
- Strategy 2 alone (identity map) is wasteful for primitives.
- The hybrid is a 7-line switch in the encoder.

## Tag layout (one byte per arg)

All multi-byte fields little-endian:

| Tag | Value      | Payload                                              |
|----:|------------|------------------------------------------------------|
| 0   | undefined  | (none)                                               |
| 1   | null       | (none)                                               |
| 2   | false      | (none)                                               |
| 3   | true       | (none)                                               |
| 4   | number f64 | 8 bytes float64                                      |
| 5   | int32      | 4 bytes int32 (fast path for small ints)             |
| 6   | string     | 4 bytes len + N bytes utf-8                          |
| 7   | object     | 4 bytes identityId + 4 bytes flags (bit0=isArray)    |
| 255 | unsupported| (none) — receiver throws                             |

Argv framing: `[u32 argc][arg-bytes ...][arg-bytes ...]...`.

## Encoder / decoder shapes

```ts
function encodeValue(value: unknown, owner: "host" | "wasm"): Uint8Array;
function decodeValue(buf: Uint8Array, offset: number): { value: unknown; byteLength: number };

function packArgv(srcCtx: Context, srcHandles: number[], srcOwner: "host"|"wasm"): Uint8Array;
function unpackArgv(dstCtx: Context, bytes: Uint8Array, srcOwner: "host"|"wasm"): {
  handles: number[];
  values: unknown[];
};
```

Sender derefs each src handle via `srcCtx.jsValueFromNapiValue(h)`,
encodes.  Receiver decodes, mints fresh handles via
`dstCtx.napiValueFromJsValue(value)`.  Both are public on `Context`
(`Context.ts:369-375`) — no private-API reach.

## Identity-map data structure

```ts
class IdentityMap {
  objToId = new WeakMap<object, number>();
  idToObj = new Map<number, { obj: object; owner: "host" | "wasm" }>();
  nextId = 1;
  put(obj, owner): number;
  get(id): { obj; owner } | undefined;
}
```

**Production must swap `idToObj` to hold `WeakRef<object>` and
register each via `FinalizationRegistry`** so cross-side GC reaps
both halves.  Probe used strong-refs for deterministic measurement.

Probe verified deduplication: 10,000 marshal calls of 500 distinct
objects added **exactly 500** map entries.  Object identity
preserved (same JS reference reaches wasm every time; handle IDs
differ per call per Node convention).

## Per-call latency (10k iters per kind, Node 24)

| kind          | per-call ns | per-call µs |
|---------------|------------:|------------:|
| undefined     |         768 |        0.77 |
| null          |         647 |        0.65 |
| bool          |         518 |        0.52 |
| int32         |         769 |        0.77 |
| double        |         735 |        0.74 |
| string-7      |        1098 |        1.10 |
| string-100    |        1382 |        1.38 |
| object        |         576 |        0.58 |
| array-10      |         541 |        0.54 |
| argv-4-mixed  |        1876 |        1.88 |

Objects/arrays marshal **faster** than primitives because they hit
the identity-map fast path (one WeakMap lookup, 8 bytes) instead of
serializing contents.

**Budget:** E4 = ~31 µs end-to-end fire.  R7 = ~1.02 µs cbinfo
synth.  R8 = ~1.88 µs argv pack + ~0.7 µs return marshal.
**Total marshaling ~2.6 µs = ~8.4% of fire budget.  Acceptable.**

## Recommended payload changes (`callback-dispatch.ts`)

Current REQ (callback-dispatch.ts:107-118):
```
[u32 shape][u32 cbPtr][u32 dataPtr][u32 env][u32 argc][u32 × argc args]
```

Replace with:
```
[u32 shape][u32 cbPtr][u32 dataPtr][u32 env]
[u32 thisArgLen][thisArgLen bytes marshaled-thisArg]   // for define_class
[u32 argLen][argLen bytes marshaled-argv]              // from packArgv()
```

Reply (currently 119-122):
```
[u32 status][u32 returnHandle][message bytes...]
```

becomes:
```
[u32 status][u32 returnBytesLen][returnBytesLen bytes marshaled-return | message bytes]
```

## Wasm-side NAPI_CALLBACK case (replaces 306-323; integrates R7)

```ts
case CALLBACK_SHAPE_NAPI_CALLBACK: {
  const argValues = unpackArgv(wasmCtx, marshaledArgvBytes, "host").values;
  const thisArgValue = unpackValue(wasmCtx, marshaledThisArgBytes, "host");
  const scope = wasmCtx.openScope(wasmEnv);
  const cbi = scope.callbackInfo;
  cbi.args = argValues;
  cbi.thiz = thisArgValue;
  cbi.data = dataPtr;
  cbi.fn = fn;
  cbi.holder = undefined;
  try {
    const ret = fn(env, scope.id);
    const retHandle = (typeof ret === "number" ? ret : 0) >>> 0;
    const retValue = wasmCtx.jsValueFromNapiValue(retHandle); // deref INSIDE scope
    returnPayloadBytes = packValue(retValue, "wasm");
  } finally {
    wasmCtx.closeScope(wasmEnv, scope);
  }
  break;
}
```

This case body also handles R7 caveat #2 (return-handle lifetime —
deref inside scope before close) and #3 (thisArg).

## Caveats

1. **GC lifetime** — strong refs in probe; production needs
   `WeakRef` + `FinalizationRegistry`.  Edge case: object GC'd
   between pack and unpack → decoder throws "identity reference
   collected".
2. **Circular refs** — handled trivially (objects mapped by
   identity, not serialized).
3. **Prototypes/class instances** — preserved (same JS reference
   crosses boundary).
4. **Symbols/BigInts** — tagged 255 (unsupported); receiver throws.
   Out of scope for last 2 ops; extensible.
5. **Functions as args** — untagged.  Path forward: route through
   OP_INVOKE_WASM_CALLBACK or treat as identity-mapped.  Out of
   scope.
6. **Per-pair identity map** — process-wide in probe; production
   should pass a per-worker-pair `IdentityMap` to both
   `registerWasmCallbackInvoker` and `makeHostSideCallbackClosure`.

## Status

**Empirically validated → R7 caveat #1 retired.**  Last 2 ops
(`napi_create_function`, `napi_define_class`) are unblocked.

## Refined integration sequencing

1. Land marshal-layer module (~150 lines: `pack`, `unpack`,
   `IdentityMap`).  Self-contained, unit-testable.
2. Land R7 cbinfo synth + R8 marshal together in
   `callback-dispatch.ts` behind a flag, NAPI_CALLBACK shape only,
   `thisArg=undefined`.  Unblocks trivial `napi_create_function`.
3. Add thisArg field to request payload.
4. Ship `napi_create_function` (full).
5. Ship `napi_define_class` (uses thisArg).

## Key file:line citations

- `vendor/emnapi/packages/runtime/src/Context.ts:369-375` — public
  `napiValueFromJsValue` / `jsValueFromNapiValue`
- `vendor/emnapi/packages/runtime/src/Isolate.ts:39-53` — impl;
  reserved IDs (undefined/null/bool/global) are constant across
  contexts
- `browser-target/src/host-worker/callback-dispatch.ts:107-122` —
  current REQ/REPLY layout (to replace)
- `browser-target/src/host-worker/callback-dispatch.ts:178-182` —
  raw u32 argv encoding that breaks cross-context (the bug)
- `browser-target/src/host-worker/callback-dispatch.ts:294-298` —
  matching raw u32 decode (also broken)
- `experiments/r7-cbinfo-synthesis/FINDINGS.md:110-119` — caveat
  #1 (this experiment)
- `experiments/r8-cross-context-marshaling/probe.mjs` — empirical
  validation
