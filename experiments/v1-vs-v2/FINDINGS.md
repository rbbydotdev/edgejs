# v1 vs v2 — findings + recommendation

**Date:** 2026-05-23
**Result:** Stay on v1; keep v2 as the swap-ready alternative.

## What was tested

Ran the L5 architectural patterns against v1 (1.10.0, installed via
npm — matches production).  Same probe steps as the v2 experiments
in `experiments/l5-emnapi-v2/`.

## Results

| Aspect | v1 (1.10.0) | v2 (2.0.0-alpha.1) | Difference |
|---|---|---|---|
| createContext | ✅ | ✅ | identical signature |
| Context class | ✅ | ✅ | internal structure differs |
| createNapiModule | ✅ | ✅ | identical signature |
| napiModule.imports.napi | 151 functions | 141 functions | v1 has more (e.g., async-work) |
| napiModule.imports.env | 37 functions | 34 functions | small delta |
| napiModule.imports.emnapi | 7 functions | 11 functions | v2 added some |
| napiModule.init({instance, module, memory, table}) | ✅ | ✅ | identical signature |
| napi_get_undefined writes handle to shared memory | ✅ handle=1 | ✅ handle=2 | both work; just different IDs |
| ctx.refStore | undefined (different internals) | Map (visible) | implementation detail |

## Conclusion

**The architectural patterns we validated in v2 work identically in v1.**
Both versions:
- Same top-level API (createContext, createNapiModule)
- Same init signature
- Same `imports.napi` shape (string→function map)
- Same C-ABI compatibility (napi standard)
- Write to shared memory the same way

Differences are internal: handle ID schemes, refStore structure, some
extra functions in one version vs the other.  None affect our split-
worker pattern.

## Strategic recommendation

**Stay on v1 (1.10.0) for L5 F-1 implementation.**

Why:
1. Matches production wasm (compiled against v1 ABI)
2. No risk to existing 234-function napi-host code
3. v2 is alpha; less stable
4. Migration is trivial later via existing facade

**The existing facade `browser-target/src/napi-host/emnapi.ts` IS the swap point.**

```typescript
// CURRENT (v1):
export { createContext } from "@emnapi/runtime";
export type { Context, Env } from "@emnapi/runtime";
export { createNapiModule } from "@emnapi/core";

// TO SWAP TO v2 (later):
export { createContext } from "../../../vendor/emnapi/packages/runtime/dist/emnapi.js";
export type { Context, Env } from "../../../vendor/emnapi/packages/runtime/dist/emnapi.d.ts";
export { createNapiModule } from "../../../vendor/emnapi/packages/core/dist/emnapi-core.js";
```

One file change.  Production stays clean.

## Discipline for L5 F-1

All new host-worker code must import via the facade.  Never:
```typescript
import { createContext } from "@emnapi/runtime"; // ❌ bypasses the swap
```

Always:
```typescript
import { createContext } from "../napi-host/emnapi"; // ✅ goes through facade
```

This is already the project rule (`memory/feedback-vendored-deps-behind-facades.md`).
The L5 F-1 implementation just needs to follow it.

## Optional: typed interface in the facade

If we want even more rigor — make the facade not just re-export but
DECLARE the minimum surface as TypeScript types.  This forces both v1
and v2 imports to satisfy the same interface.

```typescript
// browser-target/src/napi-host/emnapi.ts
import * as backend from "@emnapi/runtime";  // or vendor
import * as core from "@emnapi/core";

export interface EmnapiContext {
  // explicit minimum surface we use
}
export interface EmnapiNapiModule {
  imports: { napi: Record<string, Function>; env: Record<string, Function>; emnapi: Record<string, Function> };
  init(opts: { instance: WebAssembly.Instance; module: WebAssembly.Module; memory: WebAssembly.Memory; table: WebAssembly.Table }): void;
  // ...
}

export const createContext = backend.createContext as (opts?: unknown) => EmnapiContext;
export const createNapiModule = core.createNapiModule as (opts: unknown) => EmnapiNapiModule;
```

Cost: minor — adds 20-30 LOC of types in the facade.
Benefit: typescript will catch any v1-vs-v2 incompatibility at compile
time when we swap.

**Recommendation: do this when we do the actual swap (later).**
Premature for now; v1 works as-is.

## Bottom line

- v1 is fine for L5 F-1.  No upgrade needed.
- Facade is the swap point — single-file change to v2 later.
- New code: always import via facade.  Never direct emnapi imports.
- v2 vendor stays available for future use.
