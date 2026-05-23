# R5: diff-test harness pattern — findings

**Date:** 2026-05-23
**Status:** Pattern validated — 5/5 ops diffed correctly in the probe.

## The question

Per F-7 brief, each napi op should be diff-tested: run it both ways
(in-process and via host RPC) with identical inputs, assert outputs
match. What's the cleanest harness shape that scales to 150 ops?

## Recommended harness shape

**Per-op test-case object** as the unit of authorship:
`{ op, setup, call, resultShape }`.

Three properties make it scale:

1. **`setup(side)` runs per side**, not once — same JS value gets a fresh
   handle on each side, mirroring production's disjoint handle stores
   between wasm-internal and host-worker.
2. **`resultShape` is a discriminated tag** — `"handle" | "enum" |
   "bool" | "i32" | "u32"`. One normalizer per kind. Adding `"f64"` is
   a 5-line patch.
3. **`call(side, args, resultPtr)` is opaque** — author writes one
   call site, harness runs both sides. No duplicated call to drift.

## Diff boundary

**`napi_status` + normalized result bytes.**

- Higher (JS value equality) breaks for handle IDs.
- Lower (emnapi internals) overfits to upstream implementation.
- Handles canonicalized via `ctx.jsValueFromNapiValue(id)`.

## Risks by category

- **Callbacks** (`napi_call_function`): callback side-effects diverge
  by transport — diff only the sync return; count callback invocations
  separately.
- **Finalizers / async work / GC-driven ops**: non-deterministic across
  two contexts. Don't diff-test; cover with integration tests.
- **Wasm-aliased buffer pointers**: pointers differ, pointee bytes
  match. Use a `{ kind: "pointer", pointeeBytes: N }` shape.
- **Ref ops** (`napi_create_reference`): ref IDs aren't JS-value-derived,
  so they differ even after canonicalization. Diff status only; verify
  via round-trip with a second op.
- **`globalThis`-touching ops**: two contexts share one host realm.
  Either move to Workers (~3× complexity) or exclude (~5 ops).

## Scaling to 150 ops

**Per-category file, not per-op.** ~10 files grouped by arg-shape +
intent:
```
diff-tests/
  basic-values.mjs      type-predicates.mjs    value-getters.mjs
  properties.mjs        equals-and-coerce.mjs  references.mjs
  callbacks.mjs         tsfn.mjs               buffers.mjs
  errors.mjs
```
Shared `runner.mjs` extracted from `probe.mjs`. No codegen — shape is
regular enough that hand-authoring beats manifest+codegen on
debuggability. One exception: a 30-line scaffolder that scans
`napiModule.imports.napi` for ops not in any diff-tests file and emits
stub cases — useful when upstream emnapi adds ops.

## Recommended production location

`/Users/robertpolana/etc/projects/edgejs/browser-target/test/diff/`

Migration:
- **Phase 1**: extract `probe.mjs` → `browser-target/test/diff/runner.ts`,
  swap fake RPC for real `rpc-client.ts`.
- **Phase 2**: author one `diff-tests/<category>.ts` per F-step as ops
  cut over (matches the existing lever-b cadence of F-4/F-5/etc.).
- **Phase 3**: cutover-complete; runner becomes a regression gate. Any
  emnapi-version bump or RPC-protocol change runs the full 150-op diff.

## Observations from building it

- `ctx.napiValueFromJsValue(v)` + `ctx.jsValueFromNapiValue(id)` are
  the clean primitives for harness-side handle round-tripping. No need
  to touch `_handleStore` internals.
- emnapi requires a real env + open scope before any `napi_create_*`
  works. Must call `ctx.createEnv(...)` and `ctx.openScope(env)` after
  `napiModule.init`. The `l5-real-roundtrip` probe avoided this because
  it only used `napi_get_undefined/null/global` (no handle allocation).
- emnapi interns primitive handles — `stash("xyz")` twice returns the
  same ID. Made `napi_strict_equals` return `true`; both sides matched
  (harness diffs identical behavior, which is correct — diff-testing
  catches *transport* bugs, not napi-library bugs).

## Status for path (a)

**Tooling validated.** The harness pattern is ready to extract into the
main project. Per-category file layout scales to 150 ops without
codegen overhead. Risks (callbacks, finalizers, async, refs) are
identified with workarounds.
