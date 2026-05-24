# Wasm-aliased typed array pattern

A documented bug class, its current per-binding fix, and the shape of a
generalized solution if the class grows beyond what per-binding policies
can comfortably cover.

**Cross-references:**
- `experiments/e13-zlib-crash-debug/FINDINGS.md` — original diagnosis
- `experiments/e15-zlib-fix/FINDINGS.md` — first instance of the fix
- `experiments/e19-staleness-audit/FINDINGS.md` — audit confirming the class is bounded
- `experiments/e20-process-methods-wasm-state/FINDINGS.md` — second instance of the fix

---

## The bug class

**Symptoms:** A Node lib JS module allocates a small typed array, hands
it to a C++ binding, then reads from it after a binding call.  The reads
are wrong — either loud (assertion failures) or silent (one-call-behind
stale values).

**Trigger conditions, all must be present:**

1. JS code allocates a typed array directly in JS heap:
   `const xValues = new Uint32Array(N)`, `new Float64Array(N)`, etc.
2. The typed array is passed (by reference, not by value) to a binding
   method exposed via `internalBinding('...')`.
3. The C++ side either retains the pointer (and writes asynchronously
   on completion callbacks) OR writes through the pointer during the
   synchronous call.
4. JS later reads from the typed array, expecting fresh values.

**Why it's a problem on the browser target:** the host emnapi's
`napi_get_typedarray_info` override
(`browser-target/src/napi-host/index.ts:394-399`) syncs wasm→JS BEFORE
the C++ write.  So the JS-heap copy never receives the post-write data.
JS reads one call behind wasm.

**Why this doesn't happen in native Node:** V8 has direct access to the
typed array's backing buffer; there is no wasm↔JS sync layer.  The
C++ pointer and the JS view alias the same memory.

## Why a napi-layer fix doesn't work

E13 investigated overriding `napi_create_typedarray` (or the equivalent
hooks in emnapi) to auto-substitute wasm-backed buffers for any small
JS-heap typed array passed to C++.  This is infeasible:

- JS code already holds a direct reference to the typed array's backing
  `ArrayBuffer`.  We cannot mutate that reference (you can't swap an
  `ArrayBuffer`'s backing store).
- Replacing the emnapi handle-store entry would update C++'s view but
  not JS's `this._writeState`-style reference — JS still reads stale
  data from the original buffer.
- The intercept HAS to happen BEFORE JS captures the reference — at
  the lib-side allocation site or the binding's `init()` / method call.

The fix shape is therefore: **a {post}-patch on the lib module that
swaps the JS-heap allocation for a wasm-backed twin BEFORE the
binding sees it.**

## The current per-binding fix

A policy in `browser-target/src/policies/` patches the specific lib
module.  Two examples shipped:

### `zlib-writestate-wasm.ts` (E15)

Wraps `binding.{Zlib,BrotliEncoder,BrotliDecoder,ZstdCompress,ZstdDecompress}.prototype.init`
to intercept the `Uint32Array(2)` argument BEFORE the binding captures
it as `_writeState`.  Allocates a wasm-backed twin via
`internalBinding('buffer').createUnsafeArrayBuffer(8)` and substitutes
it into argv.

Complications it has to handle:
- `Gzip extends Zlib` etc. — JS class-extends captures the parent at
  decl time, so the local `Zlib` reference has to be reassigned for
  subclasses to pick up the wrapped version.
- Zstd specifically needed `Reflect.construct` wrapping because its
  class-extends pattern differs.

Shipped in `defaultBrowserPolicies` + `minimalPolicies` — this is a
correctness fix, not opt-in.

### `process-methods-wasm-state.ts` (E20)

Simpler than zlib — no class hierarchy, no Reflect.construct.  Four
`Float64Array(N)` allocations at module scope in
`lib/internal/process/per_thread.js`; the policy swaps each one for a
wasm-backed view.

## Known sites + status

| Site | Module | Allocation | Status |
|---|---|---|---|
| `Zlib._writeState` | `lib/zlib.js:674` | `Uint32Array(2)` | Fixed (E15) |
| `Brotli._writeState` | `lib/zlib.js:836` | `Uint32Array(2)` | Fixed (E15) |
| `Zstd writeState` | `lib/zlib.js:895` | `Uint32Array(2)` | Fixed (E15) |
| `process.cpuUsage()` | `lib/internal/process/per_thread.js:123` | `Float64Array(2)` | Fixed (E20) |
| `process.threadCpuUsage()` | `lib/internal/process/per_thread.js:163` | `Float64Array(2)` | Fixed (E20) |
| `process.memoryUsage()` | `lib/internal/process/per_thread.js:215` | `Float64Array(5)` | Fixed (E20) |
| `process.resourceUsage()` | `lib/internal/process/per_thread.js:329` | `Float64Array(16)` | Fixed (E20) |

Per E19's audit, these are the ONLY sites in all of `lib/`.

## How to detect a new instance

If you suspect a new instance (a Node API returning wrong values on
the browser target without a crash):

### Grep patterns

```sh
# Small fixed-size typed array allocations
grep -rnE 'new (Uint(8|16|32)|Int(8|16|32)|Float(32|64))Array\(' lib/

# Same, passed to a binding method
grep -rnE 'binding\._?(\w+)\(\s*\w*Values\s*\)' lib/
```

### Naming heuristic (E19)

- `*Values` suffix → strong correlation with JS-allocated TA (4/4 HIGH
  in the audit)
- `*Buffer` suffix → strong correlation with C++-allocated buffer
  (wasm-aliased, SAFE)
- Look for variables named `_writeState`, `_state`, `_handle` →
  binding state carrier, worth checking

### What's SAFE (don't chase these)

- C++-allocated buffers exposed via `napi_create_arraybuffer` (e.g.
  `v8.heapStatisticsBuffer`, `process.hrtimeBuffer`) — wasm-aliased
  from source.
- JS→C++ one-shot allocations (the TA is consumed inline, no
  retention).
- Pure constant tables (lookup arrays, never crosses napi).
- SAB + Atomics (worker-only code paths).
- Unreachable code paths in browser-target (QUIC, worker_threads
  internals, ESM hooks).

### Verifying a HIGH-confidence site

1. Find the C++ callback in `src/internal_binding/binding_*.cc` or
   `src/edge_*.cc`.
2. Look for `napi_get_typedarray_info` (or `GetFloat64ArrayData` /
   similar helpers in `src/internal_binding/util.h`).
3. The C++ writes to the buffer via the cached pointer.
4. JS reads from the JS-heap typed array after the call.

This pattern → wasm-aliased TA needed.

## When to escalate to a generalized helper

The per-binding policy pattern works because the bug class is small
(5 sites total in `lib/`).  Don't extract a helper preemptively.

**Escalate when:**

- A third NEW binding gets affected (post-E20), AND
- The two-of-three policies have meaningful shared code (similar
  allocation + swap + ringback logic), AND
- The shared code is non-trivial (>30 lines of repetition).

**Don't escalate when:**

- Only one new site appears — write a tiny dedicated policy.
- The fix shape is structurally different (e.g. async retention vs.
  sync-call writes — zlib and process-methods needed different
  surface area).

## Sketch of the generalized helper (if/when needed)

```ts
// browser-target/src/host/wasm-aliased-typedarray.ts (future)
//
// Returns a typed array of the given constructor + length, backed by
// wasm memory.  The C++ side sees a typed array whose underlying
// ArrayBuffer is the wasm SAB; JS reads/writes go directly through
// wasm memory.  No sync hop needed.
export function allocateWasmBackedTypedArray<T extends TypedArrayCtor>(
  Ctor: T,
  length: number,
): InstanceType<T>;

// Convenience for the common pattern: lib code allocates a TA at
// module scope and a binding writes through it.  Patches the lib
// source via {post} to substitute the allocation.
export function makeWasmStatePolicy(opts: {
  /** Lib module being patched (e.g. 'internal/process/per_thread'). */
  module: string;
  /** Anchor source pattern to replace (e.g.
   *  'const cpuValues = new Float64Array(2);'). */
  source: string;
  /** Replacement that allocates via the wasm-aliased path. */
  replacement: string;
}): Policy;
```

The helper itself would be ~50 LOC.  Each migrated policy becomes
~10 LOC (4 calls to `makeWasmStatePolicy` for the process methods,
for example).  Total LOC savings: maybe 100 across all known sites,
which is below the "non-trivial duplication" threshold today.

Revisit when there's a concrete need.

## Cross-cutting notes

- The bug ONLY exists on the browser target (wasm-hosted V8).  Native
  Node has direct V8 buffer access.  Hence policies are browser-only.
- The bug exists because emnapi's `napi_get_typedarray_info` syncs in
  the WRONG direction for retained TAs.  Patching emnapi instead of
  the lib could close the class — but emnapi is vendored and would
  need careful upstream coordination.  Deferred per E13.
- The fix shape (wasm-backed TA at allocation site) is also
  marginally faster than the JS-heap version, because the
  `napi_get_typedarray_info` sync hop becomes unnecessary.  Not
  measured as a perf win — correctness was the motivation.

## Future work

- Apply the audit heuristic when new lib modules land or upstream
  syncs from Node.
- If a future emnapi upgrade fixes the sync direction at the napi
  layer, delete the policies (they become no-ops).
- If a 6th HIGH site emerges and the two existing policies show
  shared structure, build the `makeWasmStatePolicy` helper.
