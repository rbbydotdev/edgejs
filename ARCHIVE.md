# Edge.js NOTES

Running log of deviations, questions, and things to consider while building
out the browser target. Newest entries first.

---

## 2026-05-21 — ModuleOverrides FileSystem adapter (foundation, with caveat)

Implemented the consumer-pluggable "swap any Node built-in" architecture
discussed earlier (see [feedback-full-node-compat-first.md](../.claude/projects/-Users-robertpolana-etc-projects-edgejs/memory/feedback-full-node-compat-first.md)
context).

### New file

[browser-target/src/host/fs/adapters/overrides.ts](browser-target/src/host/fs/adapters/overrides.ts)
— a FileSystem adapter that serves only the paths in a `ModuleOverrides`
map.  Layers above any real FS via `layered()`.  Per-call cost: a Map
lookup per `open`.

API:
```ts
type ModuleOverride = string | null | undefined;
type ModuleOverrides = { [pathOrSpecifier: string]: ModuleOverride };

const overridesFs = createOverridesFs({
  "crypto": "<CJS source>",   // swap with custom impl
  "inspector": null,          // empty stub (module.exports = {})
  "fs": undefined,            // fall through to default
});
// Wire as the top layer:
const fs = layered(overridesFs, bundledFs);
```

Bare specifiers map deterministically to `/node-lib/<name>.js`; absolute
paths are passed through as-is.  Both forms work as keys.

### Harness wiring

[browser-target/scripts/node-harness.mjs](browser-target/scripts/node-harness.mjs)
accepts `--override <specifier>:<value>`:
- `--override foo:null` → empty stub
- `--override foo:./poly.js` → source loaded from local file
- `--override foo:"module.exports=42"` → inline source

### CAVEAT — limited reach in current edge.js build

Empirically: `require('inspector')` and most other node-lib modules
**do NOT pass through WASI path_open** in the current edge.js build.
Edge loads those from a compiled-in builtin catalog instead (see
[wasix/WASIX_TODO.md](wasix/WASIX_TODO.md): the catalog is referenced
but the FS mount is the documented long-term path).

Concretely: `--override inspector:null` doesn't prevent edge's bundled
`node:inspector` from loading and throwing `ERR_INSPECTOR_NOT_AVAILABLE`.

The overrides adapter DOES work for paths edge actually fetches via
`path_open2` — which we've observed for `/node/deps/undici/src/package.json`
and similar deps-tree files.  These are the "lazy" reads from disk vs
the "compiled in" builtin core.

### Followup: true module overrides

To override compiled-in builtins, we'd need to intercept at the napi
binding layer — likely the `unofficial_napi_module_wrap_*` family or
edge's `internalBinding` resolver.  Tracked as separate chunk.

The current ModuleOverrides remains the right architectural shape for
when edge's catalog → FS migration happens, AND for deps-tree files
today.  Foundation laid for Path A+ (consumer-injected Web Crypto
polyfill, etc.) once the catalog path is plumbed through.

---

## 2026-05-21 — Crypto FULL surface working (digest + randomBytes + randomUUID)

```
$ harness -e "Buffer.poolSize=0; const c=require('crypto');
              console.log(c.createHash('sha256').update('hello').digest('hex'));
              console.log(c.randomBytes(8).toString('hex'));
              console.log(c.randomUUID())"

2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  ✓ real sha256
8249180e44877c20                                                    ✓ real random
0654d7dc-943b-440f-85e1-148f97adafd7                                ✓ real UUID v4
```

All three crypto APIs now return correct values via edge.js's bundled
OpenSSL.  Real Node compat for the crypto surface.

### What made randomUUID work

`crypto.randomUUID()` uses edge's `secureBuffer(2048)` from
`internalBinding('crypto')`.  Reading [src/internal_binding/binding_crypto.cc:8190](src/internal_binding/binding_crypto.cc):

```cpp
napi_value CryptoSecureBuffer(napi_env env, napi_callback_info info) {
  napi_create_arraybuffer(env, size, &data, &ab);
  std::memset(data, 0, size);                       // wasm-side zero
  napi_create_typedarray(env, napi_uint8_array, size, ab, 0, &out);
  return out;
}
```

The view returned to JS was over a JS-side ArrayBuffer (emnapi's
default), but edge's `randomFillSync` writes wasm-side via the pointer
returned in `data`.  JS-side reads (`uuidData[i]` in `serializeUUID`)
saw the JS snapshot — zeros.  No napi call between the write and read
to trigger our previous wasm→JS sync hook.

The architecturally correct fix: coordinated overrides for the four
napi entries that touch ArrayBuffers, replacing emnapi's
JS-with-mirror model with a wasm-source-of-truth model:

- `napi_create_arraybuffer` → returns a `Uint8Array` view over
  `wasmMemory.buffer` at the wasm `_malloc`'d offset.  Tracked in a
  `wasmBackedABs: Map<handleId, {ptr, length}>` for downstream recognition.
- `napi_create_typedarray` → if the AB arg is in our map, creates
  `new T(wasmMemory.buffer, ptr + byteOffset, length)` directly,
  bypassing emnapi's `isArrayBuffer()` check.  Result is wasm-backed,
  emnapi's `getOrUpdateMemoryView` auto-registers it in
  `wasmMemoryViewTable` on first access.
- `napi_get_arraybuffer_info` → returns ptr+length from our map for
  wasm-backed ABs.
- `napi_is_arraybuffer` → returns true for our wasm-backed handles.

Code: [browser-target/src/napi-host/index.ts](browser-target/src/napi-host/index.ts)
`patchEmnapiToUseWasmBackedBuffers`.

The Uint8Array view we use as the "ArrayBuffer" handle isn't a real
ArrayBuffer instance.  emnapi internals that bypass our overrides
might fail — none observed yet, but tracked as risk.

### Buffer.poolSize = 0 still needed for sha256

The pool path (`Buffer.allocUnsafe` slicing from a pre-allocated 8KB
shared pool) is NOT yet fixed.  Without `Buffer.poolSize = 0`, edge's
pool allocation goes through `createUnsafeBuffer(8192)` once, then
slices `new FastBuffer(allocPool, poolOffset, size)` for each subsequent
allocation.  `allocPool = allocBuffer.buffer = wasmMemory.buffer`
(because our override makes the underlying ArrayBuffer be the whole
SAB), so `poolOffset` becomes an offset INTO the entire wasm memory,
not into the 8KB pool region.

Result: pool slices land at completely wrong wasm addresses, reading
heap garbage.

`Buffer.poolSize = 0` forces every `Buffer.allocUnsafe(N)` to take the
un-pooled path (`createUnsafeBuffer(N)`) — a fresh per-call allocation,
which our overrides handle correctly.

Real fix for the pool: override edge's `allocate()` to use a separate
napi-created arraybuffer per slice, OR detect the pool-allocBuffer
allocation and route it differently.  Tracked.

### Workaround for users

For test harnesses and direct `-e` invocations, prepend
`Buffer.poolSize=0;` to the user code.  For production usage, this would
need to be set by edge's bootstrap or via a napi hook before user code
runs.

---

## 2026-05-21 — Crypto digest works: poolSize=0 bypasses edge's Buffer pool

`require('crypto').createHash('sha256').update('hello').digest('hex')` now
returns the correct sha256 hash:
`2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`.

Combined with the earlier wasm-backed Buffer overrides, this completes
the basic crypto surface (digest + randomBytes work correctly).

### How

Read edge.js's [lib/buffer.js:460](lib/buffer.js) — `allocate(size)`:
```js
function allocate(size) {
  if (size < (Buffer.poolSize >>> 1)) {
    // ... use pre-allocated 8KB pool, return slice ...
  }
  return createUnsafeBuffer(size);  // un-pooled path
}
```

Setting `Buffer.poolSize = 0` at the start of user code forces every
`Buffer.allocUnsafe(N)` call to hit the un-pooled path (`createUnsafeBuffer`),
which goes through `napi_create_buffer` and `napi_create_arraybuffer` —
both caught by our wasm-backed Buffer overrides.  Result: every Buffer is
its own wasm-memory-backed Uint8Array view.  No pool, no JS-side
`pool.set()` copy, no clobbering between JS and wasm sides.

Tried setting `Buffer.poolSize = 0` via a globalThis property descriptor
intercept in [browser-target/src/host/globals-shim.ts](browser-target/src/host/globals-shim.ts),
but edge.js's `addBuiltinLibsToObject` installs a lazy getter on
`globalThis.Buffer` via `ObjectDefineProperty(object, name, { get: () => {
delete object[name]; object[name] = val; return val; }})` — the `delete`
then `assign` pattern bypasses any pre-existing setter, so our intercept
races out.  Removed.

Current workaround: **prepend `Buffer.poolSize = 0;` to user code** in
test harnesses.  This is a per-call workaround, not a runtime-wide fix.
A real fix would need to set poolSize=0 inside edge's bootstrap, OR
override edge's `allocate()` to ignore poolSize, OR replace
`Buffer.poolSize` with a getter that always returns 0.

### What still doesn't work

- `crypto.randomUUID()` returns `00000000-0000-4000-8000-000000000000`
  (UUID v4 structure, all-zero random bits) even with `Buffer.poolSize = 0`.
  Diagnosis: edge's `randomUUID` uses `secureBuffer(16 * 128)` from
  `internalBinding('crypto')`, which is a C++ binding that allocates from
  OpenSSL's secure memory region.  It probably calls
  `napi_create_external_buffer` (or external_arraybuffer) directly with
  the OpenSSL allocation address — a path our overrides don't intercept.
  Followup: override `napi_create_external_buffer` similarly.

### Verified via the Node harness

```
$ harness -e "Buffer.poolSize=0; const c=require('crypto');
              console.log(c.createHash('sha256').update('hello').digest('hex'));
              console.log(c.randomBytes(16).toString('hex'))"

2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
3b073dfdee1824528546bc5a5b11ca16
```

---

## 2026-05-21 — Crypto.randomBytes works via emnapi external-arraybuffer path

After researching emnapi's API surface, found `emnapi_sync_memory(env, js_to_wasm, view, offset, len)`
exposed via `napiModule.emnapi.syncMemory(boolean, value, offset, len)`.  Combined
with `napi_create_external_arraybuffer` (which sets `runtimeAllocated: 0` in
the cache and avoids emnapi's JS→wasm sync), we can give edge.js a Buffer
storage strategy that doesn't clobber wasm-side writes.

Applied four overrides in [browser-target/src/napi-host/index.ts](browser-target/src/napi-host/index.ts):

1. `napi_create_arraybuffer` → routes to `napi_create_external_arraybuffer`
   internally with a wasm `malloc`'d pointer.  Edge's pool ArrayBuffers are
   now wasm-source-of-truth — emnapi never clobbers them with JS→wasm sync.
2. `napi_create_buffer` / `napi_create_buffer_copy` → wasm-backed Buffer
   via `Buffer.from(wasmMemory.buffer, ptr, len)`.  `view.buffer ===
   wasmMemory.buffer`, so `getViewPointer` returns `view.byteOffset` directly.
3. `napi_get_arraybuffer_info`, `napi_get_typedarray_info`,
   `napi_get_buffer_info` → call `emnapi.syncMemory(false, value, 0, len)`
   to wasm→JS sync BEFORE delegating, so JS-side reads see wasm-side writes.

### What works

```
$ harness -e "console.log(require('crypto').randomBytes(8).toString('hex'))"
add1f3f2d6149022    ← real random bytes
```

OpenSSL's entropy now reaches the user's Buffer.  This is the first
real Path-A crypto correctness win.

### What's still broken

```
$ harness -e "console.log(require('crypto').createHash('sha256').update('hello').digest('hex'))"
0a636f6e7374207b…   ← garbage (Node source bytes from heap)

$ harness -e "console.log(require('crypto').randomUUID())"
00000000-0000-4000-8000-000000000000   ← all-zero random bits
```

Diagnosis: digest and randomUUID go through edge.js's `Buffer.allocUnsafe`
**pool path** where the JS-side ArrayBuffer is written via
`pool.subarray(N).set(napiBuf)` — a pure JS write that doesn't propagate
to the wasm mirror.  Our wasm→JS sync hook clobbers those JS-side writes
with stale wasm bytes (the mirror was never written by edge's C++).

The truly correct fix requires either:
- Modifying edge.js's `lib/buffer.js` to skip the pool-copy when source is
  wasm-backed (but that's edge's code, not ours)
- Bidirectional sync with write-tracking in emnapi
- A wasm allocator that gives edge JS-backed buffers whose `.set()` ALSO
  writes wasm

For now, randomBytes is a real fix.  Digest correctness needs a focused
chunk that goes deeper — likely patching emnapi via patch-package.

HTTP regression check: still works (verified browser fetch returns
"hi from edge\n").

---

## 2026-05-21 — Buffer-model fix: architectural wall hit, options identified

Tried four override approaches to make edge's wasm-source-of-truth Buffer
pool play with emnapi's JS-with-mirror model.  All hit a fundamental JS
limit: `napi_create_arraybuffer` must return a value that satisfies
`value instanceof ArrayBuffer`, and JS doesn't let an ArrayBuffer be a
"slice" of another — only views can.

What's currently working:
- `patchEmnapiToUseWasmBackedBuffers` — overrides `napi_create_buffer` and
  `napi_create_buffer_copy` to wasm-allocate via the exported malloc.
  Buffers from these two paths ARE correct byte-for-byte in BOTH JS and
  wasm reads (verified with the Node harness — `Buffer.from(wasmMemory.buffer, ptr, len)`
  returns a view with `view.buffer === wasmMemory.buffer`, so emnapi's
  `getViewPointer` returns `view.byteOffset` and no sync ever runs).

What's not working:
- Edge's `Buffer.allocUnsafe` pool uses `napi_create_arraybuffer` →
  `napi_create_typedarray` chain.  The pool ArrayBuffer is JS-side, mirror
  is wasm-side, edge writes to wasm, JS-side stays stale (or worse, gets
  clobbered by emnapi's JS→wasm sync).  This is the path crypto digest
  and randomBytes both go through, hence the wrong output.
- Tried overriding `napi_create_arraybuffer` to return a Uint8Array view
  stamped as the handle — emnapi's `isArrayBuffer()` check fails
  (`value instanceof ArrayBuffer` is false for Uint8Array), so the
  bootstrap chain ahead (`napi_create_typedarray`) returns
  `napi_generic_failure` and edge aborts.  Reverted.

Routes available to actually fix:

1. **Patch @emnapi/core**.  Modify `getArrayBufferPointer` to do wasm→JS
   sync (or bidirectional with write-tracking) instead of JS→wasm.  Use
   `patch-package` or vendor a fork.  Modifies a 3rd-party lib — user
   approved this earlier as long as it stays behind a single adapter.
2. **Replace emnapi's Buffer/ArrayBuffer constructors entirely**.  Hook
   into `emnapiCtx.feature.Buffer` (settable after createContext) AND
   override the four arraybuffer napi entries (`napi_create_arraybuffer`,
   `napi_get_arraybuffer_info`, `napi_create_typedarray`,
   `napi_get_typedarray_info`).  Coordinated, but ~500 LOC.
3. **Write our own minimal napi runtime** that's wasm-backed end-to-end.
   The most architecturally clean answer.  Significant scope (1000+ LOC).

For now: crypto.digest hash bytes are CORRECT at byte indexing
(`d[0], d[1], ...` work), but `.toString('hex')` reads via the broken
pool path.  Any code that does its own hex/utf8 conversion via JS
indexing works; edge's bundled `Buffer.toString` / `Buffer.slice` etc.
do not.

Also confirmed: randomBytes goes through `napi_create_arraybuffer +
napi_create_typedarray` (NOT `napi_create_buffer`), so our existing
override doesn't catch it.  Both bugs share the same root cause.

Tracked for focused chunk.  Recommended path: Route 1 (patch emnapi
via patch-package, modify just `getArrayBufferPointer`'s sync direction).
~50 LOC patch + adapter wrapper.  We have the Node harness now so we
can verify each change in ~3s.

---

## 2026-05-21 — Node-side harness for fast napi/wasi iteration

`browser-target/scripts/node-harness.mjs` runs `edgejs.wasm` in Node directly,
using the same wasi-shim + napi-host code paths the browser uses.  Only the
FS adapter differs (a tiny `createNodeFs()` in the harness uses
`fs.readFileSync` instead of the browser's sync XHR).  Iteration loop is
~3s vs the browser's ~15s.

Usage:
```
cd browser-target
node --experimental-wasm-exnref --import ./node_modules/tsx/dist/loader.mjs \
  scripts/node-harness.mjs -e "console.log('hi')"
```

Gotchas:
- Node 22 requires `--experimental-wasm-exnref` (edge.js uses the exception
  handling proposal).
- Edge mutates Node's `globalThis.performance`, `console`, etc. during
  bootstrap — same pattern as in the browser, except in Node it leaks into
  the host's globalThis and breaks Node's lazy-loaded internals.  Workaround:
  the harness writes output via `fs.writeSync(1, …)` directly (bypasses the
  lazy `console` module) and captures `performance.now` from `node:perf_hooks`
  at top of file before edge runs.
- Cleanup throws `dynCall before table ready` from
  `unofficial_napi_create_env`'s throw-placeholders.  Doesn't affect the
  primary output; finalizer wiring is separate followup.

Used during the crypto-digest-correctness investigation to iterate ~5x
faster than the browser loop.

---

## 2026-05-21 — Crypto digest correctness — deep root cause identified, fix incomplete

Diagnosed why `createHash('sha256').update('hello').digest('hex')` returns
heap-garbage bytes despite the underlying Buffer having the correct sha256
digest at every JS-indexed offset.

### What works

- `require('crypto')` loads (#!~ from napi_define_class fix in earlier entry)
- `createHash(...).update(...).digest()` returns a Buffer with the **correct
  digest bytes** when read via `Array.from(d)` or `d[i]` (Uint8Array indexing)
- `/dev/urandom` delivers true randomness (verified: first 8 bytes vary per run)

### What's still broken

- `digest.toString('hex')` reads from a different location than `d[i]`
  — produces heap garbage that decodes to JavaScript source code fragments
- `randomBytes(N)` returns a Buffer whose bytes are all zero, despite urandom
  delivering entropy

### Root cause (digest)

The digest Buffer has `byteOffset: 8` within an 8192-byte underlying
ArrayBuffer.  Edge's `Buffer.prototype.toString` calls `hexSlice(this, ...)`,
which is a C++ binding imported from `internalBinding('buffer')`.  The C++
walks the buffer via napi_get_buffer_info → napi_get_typedarray_info →
emnapi's `getViewPointer(view, true)` → `getArrayBufferPointer(view.buffer, true)`.

emnapi maintains a **wasm-memory mirror** of every JS ArrayBuffer.  The mirror
is allocated lazily via `_malloc` and ONE-WAY-synced JS→wasm only at specific
points (with shouldCopy=true).  For our digest path:

1. emnapi's `napi_create_buffer_copy` allocates a JS ArrayBuffer (32 bytes,
   zero), calls `Buffer.from(arrayBuffer)`, then `buffer.set(srcBytes)` writes
   the digest INTO the JS ArrayBuffer.  ← JS now correct.
2. emnapi's `emnapiCreateArrayBuffer` simultaneously mallocs wasm memory and
   copies the (still-empty) ArrayBuffer to it.  ← wasm mirror still zero.
3. Edge's lib wraps the napi Buffer into its own Buffer pool: copies bytes
   into pool's JS ArrayBuffer at offset 8.  Returns view(pool, 8, 32).
4. C++ hexSlice calls `napi_get_buffer_info` on that view.
5. emnapi's getViewPointer is supposed to re-sync JS→wasm at this point
   (`shouldCopy=true`).
6. But the address returned is `mirror_addr + view.byteOffset = P + 8` —
   reading past the malloc'd 32-byte region into adjacent uninitialized heap.

Each run shows a different garbage byte pattern from the pool's adjacent
heap — confirmed: bytes decode to JS source code from various Node lib
files that emnapi previously allocated in the same wasm region.

We patched `napi_create_buffer_copy` to copy `src → mirror` after emnapi's
call (see `patchEmnapiBufferMirror` in
[browser-target/src/napi-host/index.ts](browser-target/src/napi-host/index.ts)).
This didn't resolve it because edge's pool path goes through a separate
ArrayBuffer (via `napi_create_arraybuffer`), not the one we patched.

### What would actually fix it

Three options, in increasing scope:

1. **Override Buffer.prototype.toString** to a JS-side impl that uses
   Uint8Array indexing.  Bypasses the C++ binding for this one path.
   ~30 LOC.  Doesn't fix every C++ Buffer reader (utf8Slice, base64Slice,
   etc. all have the same issue).
2. **Make emnapi's wasm-memory-mirror live-synced**: hook ArrayBuffer
   writes via Proxy or replace `Buffer.prototype.set` to also write to
   the wasm mirror.  Or hook getOrUpdateMemoryView to ALWAYS sync.
   ~100 LOC; touches emnapi internals.
3. **Replace emnapi's ArrayBuffer allocation with wasm-memory-backed
   buffers** — every JS ArrayBuffer is a slice of wasm linear memory.
   No mirror needed because there's no separate JS store.  Requires a
   `Buffer.allocUnsafe`-equivalent allocator in our shim that knows how
   to carve wasm memory.  Significant work.

### Status

`require('crypto')` loads, hash bytes are correct in JS, but anything
that uses C++ buffer accessors (`toString`, `slice`, `compare`) reads
stale wasm-mirror bytes.  Affects more than just crypto — anywhere a
Buffer is created via emnapi and read via C++ Buffer methods.

This is a structural issue in the emnapi ↔ edge interaction, not a
crypto-specific bug.  Tracked for follow-up.

---

## 2026-05-21 — Crypto: napi_define_class + Buffer polyfill unblocks load

`require('crypto')` now loads cleanly.  Three calls produce structurally-valid
output (createHash → 64 hex chars, randomBytes → hex string, randomUUID →
correct v4 format).  Values themselves are still wrong — separate follow-up.

### Two fixes landed

1. **`napi_define_class` empty-descriptor crash.**  emnapi's
   `emnapiDefineProperty` (at `@emnapi/core/dist/emnapi-core.esm-bundler.js:4040`)
   reads `handleStore.get(value).value` in its else-branch without checking
   that `value !== 0`.  Edge's crypto bindings (and likely others) call
   `napi_define_class` with property descriptors where all of
   {method, getter, setter, value} are zero — standard N-API for
   "property with no initial value".  emnapi crashes dereferencing handle 0.

   Fix in [browser-target/src/napi-host/index.ts](browser-target/src/napi-host/index.ts):
   `patchEmnapiDefineForEmptyValue()` wraps emnapi's `napi_define_class`
   and `napi_define_properties` (same bug class), walks the descriptor
   array, and rewrites `value: 0` to `value: 1` (= `GlobalHandle.UNDEFINED`).
   emnapi then resolves it to `undefined` — the intended N-API semantics
   for a value-less descriptor.

2. **Buffer polyfill on `globalThis`.**  emnapi's
   `@emnapi/runtime/dist/emnapi.esm-bundler.js:156` captures
   `_Buffer = typeof Buffer === 'function' ? Buffer : require('buffer').Buffer`
   at *module evaluation* time.  In a worker, neither resolves, so
   `napi_create_buffer_copy` throws `NotSupportBufferError`.

   Fix: vendored npm `buffer` package (MIT, the canonical Node Buffer
   polyfill).  New file
   [browser-target/src/host/globals-shim.ts](browser-target/src/host/globals-shim.ts)
   imports `Buffer`, assigns to `globalThis.Buffer`.  Imported BEFORE
   `@emnapi/*` in `napi-host/index.ts` so the capture sees our shim.

   Per facade rule, this is the only file in the codebase that imports
   from the `buffer` package.

### Still broken (follow-up)

- `createHash('sha256').update('hello').digest('hex')` returns 64 hex
  chars of JavaScript source bytes (heap garbage), not the real digest.
  Suspect: `napi_create_buffer_copy` reading wrong wasm address, OR edge's
  C++ digest output buffer isn't where we expect.
- `crypto.randomBytes(16)` returns all-zero bytes.  `nativeGetRandomValues`
  is now cached at module load (added defensively per the
  globalThis-mutation pattern) but didn't change the output.  OpenSSL's
  CSPRNG may not be seeding from `/dev/urandom`, or the seed path takes
  some other syscall.
- `crypto.randomUUID()` returns `00000000-0000-4000-8000-000000000000`
  — UUID v4 structure correct but all-zero random bits.  Same root cause
  as randomBytes.
- `Uncaught Error: dynCall before table ready` surfaces async after
  `_start` returns when the crypto probe runs.  Our
  `unofficial_napi_create_env` passes throw-placeholders for dynCall
  callbacks; something queues a deferred callback after instance binding.
  Not blocking load.

### Memory added

[feedback-full-node-compat-first](../.claude/projects/-Users-robertpolana-etc-projects-edgejs/memory/feedback-full-node-compat-first.md)
— prefer fixing the real napi/wasi layer over polyfilling at the JS
layer.  Web Crypto can't reach 100% Node compat (MD5, DES, X.509, sync
APIs are gaps).

---

## 2026-05-21 — Chunk B: writable FileSystem layer (fs.writeFileSync works)

Stood up the writable layer of the FS facade.  Userland workloads that
read/write files in `/tmp`, `/home/edge`, etc. now round-trip cleanly.

Worker args were temporarily switched to:

```js
const fs = require('fs');
fs.writeFileSync('/tmp/test.txt', 'hi from edge');
console.log('read:', fs.readFileSync('/tmp/test.txt', 'utf8'));
```

Output:

```
[wasi] path_open2 /tmp/test.txt → fd 108 (fs/rw)
[wasi] path_open2 /tmp/test.txt → fd 109 (fs/ro)
[stdout] read: hi from edge
_start ran 155 ms (returned)
```

Worker args were restored to the chunk-C HTTP demo afterward; the demo
still prints `[stdout] listening` (verified end-to-end).

### Architecture decision: Option A (in-memory map) for v1

Picked Option A from the brief.  Real OPFS persistence (Option B, async
pre-warm of mount-point dir handles; Option C, SAB+Atomics bridge to a
sister worker holding handles) is deferred to chunk B-2.  The shim
contract is synchronous and obtaining a `FileSystemSyncAccessHandle`
requires an async `getFileHandle({create:true})` first, so either
approach needs a non-trivial sync/async boundary that wasn't worth
fighting before proving the layered-architecture works end-to-end.

The factory is still async (`createOpfsFs`) so chunk B-2 can swap the
storage body for a real OPFS pre-walk without touching `worker.ts` or
`wasi-shim.ts`.  Naming the file `opfs.ts` keeps the call site honest
about the intended destination.

### Files added / changed

| Path | Lines | Role |
|---|---|---|
| `browser-target/src/host/fs/adapters/opfs.ts` | 305 (new) | In-memory writable adapter; async factory; #!~debt opfs-not-yet-persistent |
| `browser-target/src/host/fs/adapters/layered.ts` | 168 (new) | Ordered fan-out for reads, first-writable for writes; packs `(adapterIndex, innerHandle)` into one FsHandle |
| `browser-target/src/host/fs/adapters/bundled.ts` | +5 | Added `write()` -> ROFS for the FileSystem interface |
| `browser-target/src/host/fs/types.ts` | +8 | Added `write(handle, src)` to the interface |
| `browser-target/src/wasi-shim.ts` | ~+25 | Added oflags/rights -> OpenOptions translation in `path_open` + `path_open2`; routed `writeBytesToFd` through `ctx.fs.write` for fs-backed fds |
| `browser-target/src/worker.ts` | ~+10 | Constructed `opfsFs` (async), composed `layered(bundledFs, opfsFs)`, replaced `fs: bundledFs` with `fs` |

### Layered combinator semantics (load-bearing)

- Reads try each adapter in order; first non-NOENT wins.  Bundled
  claims `/node-lib/**` + `/node/deps/**`; opfs claims everything else.
- Writes go to the first adapter that DOESN'T return ROFS.  Bundled
  returns ROFS for any write, so writes route straight to opfs.
- Handles are packed `(adapterIndex << 24) | innerHandle`.  Each
  read/write/close/etc. dispatches back to the same adapter.  Keeps
  adapter fd namespaces independent.

### #!~debt added

- `opfs-not-yet-persistent` (opfs.ts file header) — backed by a flat
  in-memory `Map<path, Uint8Array>`.  Tab reload loses state.  Real
  OPFS via `FileSystemSyncAccessHandle` lands in chunk B-2.
- `opfs-flat-store` (opfs.ts, implicit in file header) — directories
  aren't modeled; readdir() enumerates direct children by scanning all
  keys with the dir prefix.  Works for the cases that exercise it,
  could be O(n) on big trees.  Real OPFS naturally inherits the
  directory tree structure.

### WASI flag translation (new code path)

`path_open` / `path_open2` now translate the WASI oflags / rightsBase
into our `OpenOptions`:

- `OFLAGS_CREAT` (0x1) -> `create: true`
- `OFLAGS_TRUNC` (0x8) -> `truncate: true`
- `OFLAGS_DIRECTORY` (0x2) -> `directory: true`
- `RIGHTS_FD_WRITE` (0x40) bit set in rightsBase -> `write: true`

Native Node `fs.writeFileSync` calls land with `oflags = 0x9`
(CREAT|TRUNC) and `rightsBase` having the FD_WRITE bit, which gets
translated correctly and routes to opfs through layered's
first-writable rule.

### Unexpected things the next chunk should know

1. The `[wasi] path_open2 /tmp/test.txt -> fd 108 (fs/rw)` log emits
   TWICE during a writeFileSync+readFileSync sequence — once for the
   write open (fd 108) and once for the read open (fd 109).  Edge
   closes between them.  Means edge.js is doing its own open/close
   per syscall, not reusing an open handle — fine, no caching needed
   on our side.
2. Existing `bundled` adapter doesn't claim `/tmp/**` paths (returns
   NOENT for anything outside its two prefixes), which is exactly
   what `layered` needs to fall through to opfs.  No changes there.
3. The `_fdflags` arg from `path_open*` is still ignored — edge isn't
   passing FD_APPEND in any observed call, but if it ever does, the
   in-memory adapter would silently overwrite from cursor 0 instead.
   Worth wiring through if a workload hits this.  Easy fix when the
   need surfaces.
4. `fd_seek` returns `0` and never updates the cursor — meaning
   `fs.readFileSync` after a `fs.writeFileSync` works only because
   edge re-opens the file (fresh handle, cursor at 0).  Random-access
   `fs.read` / `fs.write` on the same fd would misbehave.  Real seek
   support is a follow-up; today's userland workloads pass.

---

## 2026-05-21 — Capability probe + chunk H (timers) free-win

Switched worker args temporarily to small probes after chunk C landed:

- **Timers — work for free.**  `setTimeout(cb, 100)` and `setTimeout(cb, 250)`
  fire correctly in order, `process.exit(0)` returns cleanly.
  ```
  [stdout] before
  [stdout] after 100ms
  [stdout] after 250ms
  _start ran 386 ms (returned)
  ```
  Chunk H is done with zero work — `poll_oneoff` (built for sockets in
  chunk C) with `Atomics.wait` timeout handling is exactly what libuv's
  timer scheduler needs.  No separate timer implementation required.

- **`fs.writeFileSync` fails** with `ENOENT: no such file or directory,
  open '/tmp/test.txt'` — as expected.  The `bundled` adapter is
  read-only and `/tmp` isn't a served prefix.  Unblocks: chunk B (OPFS).

- **`require('crypto')` fails** at module load.  Stack:
  ```
  TypeError: Cannot read properties of undefined (reading 'value')
    at emnapiDefineProperty (.../@emnapi_core.js:4906:50)
    at napi_define_class (.../@emnapi_core.js:5148:11)
    at createNativeKeyObjectClass (eval at emnapiCreateFunction ...)
    at node:internal/crypto/keys:107:5
  ```
  Bug is inside emnapi's `napi_define_class` — reads `.value` on an
  undefined property descriptor.  Property descriptor format mismatch
  between what edge passes and what emnapi expects.  Not in our shim;
  needs either an emnapi adapter or a `napi_define_class` override.
  Tracked as new follow-up.

Worker args restored to the chunk-C HTTP demo (`http.createServer`
running, ready for fetch).

---

## 2026-05-20 — MILESTONE: edge.js serves HTTP in browser (chunk C)

```js
// Worker runs:
require('http').createServer((req,res) => res.end('hi from edge\n')).listen(3000, () => console.log('listening'));

// Page does:
await fetch('/_edge/test').then(r => r.text());
// → "hi from edge\n"  (status 200)
```

Full HTTP roundtrip end-to-end through the browser.  Real Node
`http.createServer` callback fires for each request, real response is
shipped back to the `fetch()` caller on the page.

### Architecture

```
page fetch('/_edge/*')
  → Service Worker intercepts
  → posts {edge-req} to page (SAB doesn't cross postMessage→SW on Chrome 148)
  → page writes JSON into bridgeSab, Atomics.notify(wakeSab, 0)
  → worker's blocked Atomics.wait wakes
  → drainBridgeSab() pulls request out of SAB
  → bus.pushRequest() queues it on listening socket
  → sock_accept_v2 dequeues, allocates conn fd, stages raw HTTP/1.1 bytes
  → edge calls fd_fdstat_get (we classify as SOCKET_STREAM = 6)
  → edge calls fd_read, copies the HTTP request into wasm memory
  → edge's lib/http parses, dispatches to user handler
  → user handler: res.end('hi from edge\n')
  → edge calls fd_write with full HTTP response (~108 bytes)
  → shim auto-detects complete response (parses Content-Length), closes
  → closeConnection parses sendBuf, fires responder
  → worker postMessages {page-edge-res} to page
  → page sw.postMessage()s to SW
  → SW resolves the original fetch event with the Response
```

### Bug chain hit during bring-up (all fixed)

1. **`fd_fdstat_get` returned CHARACTER_DEVICE for socket fds.**  Edge's
   libuv treated the fd as a tty and skipped recv entirely.  Fixed: return
   `6` (SOCKET_STREAM) when `sockets.has(fd)`.

2. **Edge writes the response but never calls `fd_close` or `sock_shutdown`.**
   HTTP/1.1 server expects the client to close after `Connection: close`.
   Our virtual loopback has no real client.  Fixed: added `sock_shutdown`
   impl (was falling through to ENOSYS stub), and added an
   `isHttpResponseComplete()` heuristic that auto-closes the connection
   in `writeBytesToFd` as soon as the sendBuf holds a full HTTP/1.1
   response (Content-Length detected).

3. **SAB doesn't cross MessagePort.postMessage into a Service Worker on
   Chrome 148.**  Plain objects on the same port arrive fine, anything
   containing a SAB silently drops with no error event.  Routing through
   the page (SW → Clients.postMessage → page → SAB write + Atomics.notify)
   is the only working path.

### #!~debt added

- `single-listener` — one listening socket at a time
- `no-keep-alive` — request synthesizer adds `Connection: close`
- `no-chunked-encoding` — auto-flush requires Content-Length in response
- `no-outbound` — `sock_connect` returns ENOSYS
- `no-socketpair` — `sock_pair` returns ENOSYS
- `no-sendfile` — `sock_send_file` returns ENOSYS
- `sw-sab-incompat` — workaround for Chrome's SW/SAB issue
- `single-flight` — one inflight request at a time in `sw.js`

---

## 2026-05-20 — `unofficial_napi_*` phantom-arg audit (FIXED)

Systematic audit of all 80 `unofficial_napi_*` impls in
[browser-target/src/napi-host/unofficial.ts](browser-target/src/napi-host/unofficial.ts)
against the ground-truth wasm signatures in
[napi/src/guest/napi.rs](napi/src/guest/napi.rs).

The wasm-visible signature for each `guest_unofficial_napi_xxx` is the Rust
function signature **minus** the `FunctionEnvMut<NapiEnv>` first parameter
(that's a wasmer host construct, not a wasm arg).

### Results

| Function | Wasm args | Our args (before) | Status (before) | Action |
|---|---|---|---|---|
| `set_flags_from_string` | 2 | 2 | OK | none |
| `create_env` | 3 | 3 | OK | none |
| `create_env_with_options` | 4 | 4 | OK | none |
| `release_env` | 1 | 1 | OK | none |
| `release_env_with_loop` | 2 | 2 | OK | none |
| `low_memory_notification` | 1 | 1 | OK | none |
| `process_microtasks` | 1 | 2 | phantom env | FIXED |
| `request_gc_for_testing` | 1 | 2 | phantom env | FIXED |
| `set_prepare_stack_trace_callback` | 2 | 2 | OK | none |
| `get_promise_details` | 5 | 5 | OK (just fixed) | u8 fix for has_result_ptr |
| `get_proxy_details` | 4 | 5 | phantom env + bogus is_proxy_out | FIXED |
| `preview_entries` | 4 | 5 | phantom env + arg-order swap | FIXED |
| `get_call_sites` | 3 | 4 | phantom env | FIXED |
| `get_caller_location` | 2 | 3 | phantom env | FIXED |
| `arraybuffer_view_has_buffer` | 3 | 4 | phantom env + u8 width | FIXED |
| `get_constructor_name` | 3 | 4 | phantom env | FIXED |
| `create_private_symbol` | 4 | 4 | OK | none |
| `get_continuation_preserved_embedder_data` | 2 | 3 | phantom env | FIXED |
| `set_continuation_preserved_embedder_data` | 2 | 3 | phantom env | FIXED |
| `notify_datetime_configuration_change` | 1 | 2 | phantom env | FIXED |
| `set_enqueue_foreground_task_callback` | 3 | 3 | OK | none |
| `set_fatal_error_callbacks` | 3 | 3 | OK | none |
| `terminate_execution` | 1 | 2 | phantom env | FIXED |
| `cancel_terminate_execution` | 1 | 2 | phantom env | FIXED |
| `request_interrupt` | 3 | 4 | phantom env | FIXED |
| `structured_clone` | 3 | 5 | wrong sig (was wired to 4-arg with-transfer body) | FIXED |
| `structured_clone_with_transfer` | 4 | 5 | phantom env | FIXED |
| `serialize_value` | 3 | 4 | phantom env | FIXED |
| `deserialize_value` | 3 | 4 | phantom env | FIXED |
| `release_serialized_value` | 1 (void) | 2 (returned 0) | phantom env + non-void return | FIXED |
| `set_promise_hooks` | 5 | 5 | OK | none |
| `get_own_non_index_properties` | 4 | 5 | phantom env | FIXED |
| `get_process_memory_info` | 5 | 7 | phantom env + bogus rss arg + u64 instead of f64 | FIXED |
| `get_hash_seed` | 2 | 3 | phantom env | FIXED |
| `get_error_source_positions` | 3 (one struct ptr) | 6 (four scalar ptrs) | phantom env + wrong struct layout | FIXED |
| `preserve_error_source_message` | 2 | 3 | phantom env | FIXED |
| `mark_promise_as_handled` | 2 | 3 | phantom env | FIXED |
| `get_heap_statistics` | 2 | 3 | phantom env + 13 vs 14 fields | FIXED |
| `get_heap_space_count` | 2 | 3 | phantom env | FIXED |
| `get_heap_space_statistics` | 3 | 4 | phantom env + wrong struct size (was 32, is 80) | FIXED |
| `get_heap_code_statistics` | 2 | 3 | phantom env | FIXED |
| `set_stack_limit` | 2 | 3 | phantom env | FIXED |
| `set_near_heap_limit_callback` | 3 | 4 | phantom env | FIXED |
| `remove_near_heap_limit_callback` | 2 | 3 | phantom env | FIXED |
| `free_buffer` | 1 (void) | 2 (returned 0) | phantom env + non-void return | FIXED |
| `start_cpu_profile` | 3 | 4 | phantom env + wrong args (was title/options) | FIXED |
| `stop_cpu_profile` | 5 | 4 | phantom env + missing args | FIXED |
| `start_heap_profile` | 2 | 3 | phantom env + bogus options arg | FIXED |
| `stop_heap_profile` | 4 | 3 | phantom env + missing args | FIXED |
| `take_heap_snapshot` | 4 | 3 | phantom env + missing args | FIXED |
| `create_serdes_binding` | 2 | 3 | phantom env | FIXED |
| `contextify_make_context` | 9 | 7 | phantom env + missing args | FIXED |
| `contextify_dispose_context` | 2 | (missing) | impl was absent, fallback worked | ADDED |
| `contextify_run_script` | 12 | 12 | OK (just fixed) | none |
| `contextify_compile_function` | 12 | 12 | OK | none |
| `contextify_compile_function_for_cjs_loader` | 6 | 6 | OK | none |
| `contextify_contains_module_syntax` | 6 | 7 | phantom env + missing cjs_var_in_scope | FIXED |
| `contextify_create_cached_data` | 7 | 7 | phantom env + missing host_defined_option_id | FIXED |
| `module_wrap_create_source_text` | 9 | 10 | phantom env + missing context_or_undefined + extra host_defined_option_id | FIXED |
| `module_wrap_create_synthetic` | 7 | 7 | phantom env + missing context_or_undefined | FIXED |
| `module_wrap_create_required_module_facade` | 3 | 4 | phantom env | FIXED |
| `module_wrap_create_cached_data` | 3 | 4 | phantom env | FIXED |
| `module_wrap_destroy` | 2 | 3 | phantom env | FIXED |
| `module_wrap_get_module_requests` | 3 | 4 | phantom env | FIXED |
| `module_wrap_link` | 4 | 5 | phantom env | FIXED |
| `module_wrap_instantiate` | 2 | 3 | phantom env | FIXED |
| `module_wrap_evaluate` | 5 | 4 | phantom env + missing timeout (i64) + break_on_sigint | FIXED |
| `module_wrap_evaluate_sync` | 5 | 4 | phantom env + missing filename + parent_filename | FIXED |
| `module_wrap_get_namespace` | 3 | 4 | phantom env | FIXED |
| `module_wrap_get_status` | 3 | 4 | phantom env | FIXED |
| `module_wrap_get_error` | 3 | 4 | phantom env | FIXED |
| `module_wrap_has_top_level_await` | 3 | 4 | phantom env + u8 width | FIXED |
| `module_wrap_has_async_graph` | 3 | 4 | phantom env + u8 width | FIXED |
| `module_wrap_check_unsettled_top_level_await` | 4 | 4 | OK (default-value just fixed) | added missing `warnings` arg + u8 width |
| `module_wrap_set_export` | 4 | 5 | phantom env | FIXED |
| `module_wrap_set_module_source_object` | 3 | 4 | phantom env | FIXED |
| `module_wrap_get_module_source_object` | 3 | 4 | phantom env | FIXED |
| `module_wrap_set_import_module_dynamically_callback` | 2 | 3 | phantom env | FIXED |
| `module_wrap_set_initialize_import_meta_object_callback` | 2 | 3 | phantom env | FIXED |
| `module_wrap_import_module_dynamically` (stub) | 4 | 6 | phantom env + extra args; should return 1 | FIXED + return 1 |
| `get_current_stack_trace` (stub) | 3 | 4 | phantom env; should return 1 | FIXED + return 1 |

### Summary

- Total impls audited: 79 (matching the registered wasm imports in
  `napi/src/guest/napi.rs:5051-5145`).
- Fully aligned before audit: 13.
- Misaligned (phantom env or other arity drift): 65.
- Missing impl, falling through to the namespace fallback (which returned 0):
  1 (`contextify_dispose_context`; added).
- Type-width fixes folded in: 9 instances of "boolean" out-pointers were
  writing 4 bytes via `setInt32` where Rust uses `write_guest_u8` (1 byte) —
  fixed to `setUint8`.  These are: `get_promise_details.has_result_ptr`,
  `arraybuffer_view_has_buffer.result_ptr`, `preview_entries.is_key_value_ptr`,
  `module_wrap_has_top_level_await.result_ptr`,
  `module_wrap_has_async_graph.result_ptr`,
  `module_wrap_check_unsettled_top_level_await.settled_ptr`,
  `contextify_contains_module_syntax.result_ptr`,
  `stop_cpu_profile.found_ptr`, `start_heap_profile.started_ptr`,
  `stop_heap_profile.found_ptr`.
- `get_process_memory_info` was writing zero-filled u64s into what wasm reads
  as f64 — same bit-pattern as +0.0, so no observable difference, but the
  declared type was wrong.  Fixed to `setFloat64`.
- `get_heap_statistics` struct in Rust has 14 fields, not 13 (impl had one
  field short, which would leave the last field uninitialized in caller
  memory).  Fixed.

### Verification

- `cd browser-target && npx tsc --noEmit` is clean (no errors).
- Browser run `edge -e "console.log('hello from edgejs in browser')"`
  passes: stdout shows the message, `_start ran ... (returned)` with no
  exit/error.  See verification log near the milestone entry below.

### Not addressed

- The five impls completely missing from `unofficial.ts` (and thus relying on
  the per-namespace fallback returning 0) are NOT added by this audit, since
  they're not wrong, just minimal: `set_embedder_hooks`, `enqueue_microtask`,
  `set_promise_reject_callback`, `set_source_maps_enabled`,
  `set_get_source_map_error_source_callback`, `get_error_source_line_for_stderr`,
  `get_error_thrown_at`, `take_preserved_error_formatting`.  Promote when a
  workload needs them.

---

## 2026-05-20 — MILESTONE: edge.js runs user JS in browser

```
[stdout] hello from edgejs in browser
_start ran 164 ms (returned)
```

`edge -e "console.log('hello from edgejs in browser')"` executed cleanly
in the browser harness.  Real Node.js code running inside the wasm,
writing to stdout via fd_write, returning normally (no error exit).

What got us here in this session:

1. **#14 uv_cwd EIO** — root-caused to edge mutating `globalThis.TextEncoder`
   mid-bootstrap; fixed by caching the native instance at module load.
   See entry below.
2. **`compile_function_for_cjs_loader` wrong signature** — was 13 args,
   native is 6.  Fixed to match `napi/src/guest/napi.rs:5182` and
   synthesize the CJS params array internally.
3. **`this`-binding bug in 3 delegation sites** — `wrapImpl` in
   `imports-generated.ts` drops `this`.  Refactored to `impls.X`
   closure pattern.
4. **Exit code 13 = kUnsettledTopLevelAwait** (NOT kGenericUserError as
   originally diagnosed).  Three impl bugs caused it:
   - `get_promise_details` had a phantom `_napiEnv` arg that shifted the
     state_ptr write to the wrong address; edge's IsPromisePending then
     read its stack-default 0 (pending), cascading into the TLA gate.
   - `module_wrap_check_unsettled_top_level_await` defaulted to 0
     (unsettled).  Flipped to 1 (settled) since our module_wrap impls
     are stubs that don't host real TLA semantics.
   - `contextify_run_script` had a phantom `_ctx` arg that shifted
     `sourceHandle` to read the *filename* ("[eval]") instead of the
     user code.  `new Function("return ([eval]);")` returned a JS array
     instead of executing console.log.

### #!~debt: systemic phantom `_napiEnv` in unofficial_napi_* impls

A pattern audit found that **several `unofficial_napi_*` impls have an
extra `_napiEnv` parameter that doesn't exist in the wasm signature.**
The wasmer host's `FunctionEnvMut<NapiEnv>` is implicit on the Rust side,
so wasm calls have exactly one env handle, not two.

Confirmed misaligned (only `get_promise_details`, `contextify_run_script`,
and `check_unsettled_top_level_await` correctly-aligned-but-wrong-default
were fixed above):

- `unofficial_napi_get_proxy_details` — wasm 4 args, our 5
- `unofficial_napi_contextify_make_context` — wasm 9 args, our 7
- `unofficial_napi_contextify_contains_module_syntax` — wasm 6 args, our 7
- likely more across the 80-function surface

These are silent landmines.  They don't trigger today because they're
not called yet, but they will misbehave once edge runs real workloads.
**Follow-up: systematic audit pass — diff every unofficial_napi_* impl
arity in `unofficial.ts` against the guest sig in
`napi/src/guest/napi.rs`.**  Tracked as a new task.

### Lesson saved to memory

Pattern saved at `~/.claude/projects/-Users-robertpolana-etc-projects-edgejs/memory/project-globalthis-mutation.md`
covering the globalThis mutation issue.  Also worth keeping: the systemic
phantom-arg pattern documented here.

---

## 2026-05-20 — #14 uv_cwd EIO: FIXED

The TextEncoder root cause from attempt #6 (entry below) was fixed by
caching the native `TextEncoder` at module load in
[browser-target/src/wasi-shim.ts](browser-target/src/wasi-shim.ts) and
[browser-target/src/napi-host/unofficial.ts](browser-target/src/napi-host/unofficial.ts),
and by precomputing `FIXED_CWD_BYTES` for `getcwd`.

All `new TextEncoder()` / `new TextDecoder()` constructions inside hot
paths were replaced with the module-level cached instances.  The
instrumentation block in `getcwd` was removed.

### Verification

Browser run after the fix:

```
✓ end-to-end success (exit=0)   ← hello.wasm smoke test
…
[no EIO line — uv_cwd no longer fails]
_start ran 262 ms (exit=1)
```

`_start` now runs for ~800ms (was ~120ms) and dies at a NEW error
downstream:

```
TypeError: Cannot read properties of undefined
  (reading 'unofficial_napi_contextify_compile_function')
at unofficial_napi_contextify_compile_function_for_cjs_loader (unofficial.ts:439:19)
```

This is a `this`-binding bug in our delegation pattern — the wrapImpl
wrapper in `imports-generated.ts` calls `fn(...args)` with no `this`,
so `(this as Record<string, Function>).unofficial_napi_*` is undefined.
Easy fix; tracked as a new task.

### Lesson applied to memory

Anything that's resolved through `globalThis.*` at call time is a
potential bug.  Edge's bootstrap WILL replace constructors and
prototypes mid-run.  Always capture at module load.  The
already-fixed list: `performance.now`, `performance.timeOrigin`,
`TextEncoder`, `TextDecoder`.  Future audit candidates flagged in
attempt #6 entry: `Uint8Array`, `DataView`, `Atomics`, `Math.random`,
`JSON.*`.

---

## 2026-05-20 — uv_cwd EIO: attempt #6 — ROOT CAUSE FOUND (TextEncoder mutation)

**Verdict: the bug is JS-side, not wasm-side.**  Edge.js's bootstrap mutates
`globalThis.TextEncoder` partway through boot, replacing it with a non-native
implementation whose `encode("/")` returns `Uint8Array([0])` instead of
`Uint8Array([0x2f])`.  The WASIX `getcwd` shim
([browser-target/src/wasi-shim.ts:540](browser-target/src/wasi-shim.ts))
re-encodes the cwd per call via `new TextEncoder().encode(FIXED_CWD)`,
so calls after the mutation copy a NUL byte into the guest buffer.
The C++ `TryGetCurrentWorkingDirectoryString` reads `strlen("\0") = 0`
(or sees the resized `std::string` as effectively empty after the
embedded NUL), and synthesizes UV_EIO at func[6035] block J / offset
`0x11fb60`.

### Evidence — instrumented `getcwd` (still in tree as `#!~debt`)

Per-call log captured 21 invocations during boot.  The differentiator is
the first byte of `new TextEncoder().encode("/")`:

| idx | isNative | encBytes | memByteLength |  notes                  |
|-----|----------|----------|---------------|-------------------------|
| 1   | true     | [47]     | 22151168      | edge global mutation not yet applied |
| ... | true     | [47]     | ...           | works                   |
| 18  | true     | [47]     | 22675456      | last successful call    |
| 19  | **false**| **[0]**  | 22872064      | edge mutated TextEncoder; "/" encodes to [0] |
| 20  | false    | [0]      | 22872064      | broken                  |
| 21  | false    | [0]      | 22872064      | **trigger call** — EIO fires |

The mutation happens between calls 18 and 19, coincident with a
`memory.grow` (22675456 → 22872064) — same window the prior attempts
fixated on, but the memory-grow was a coincidence, not the cause.

Additional invariants confirmed during the probe (sanity checks for
discarded candidates):

- `dv.setUint32(bufSizePtr, enc.length, true)` lands correctly all 21
  calls.  `sizeReadBack`, `sizeFreshDv`, `sizeFreshU8` all return 1.
  Candidate 1 (wrong bufSizePtr address) is **ruled out**.
- `mem.set(enc, bufPtr)` writes whatever bytes `enc` contains.  When
  `enc[0] === 47`, `mem[bufPtr] === 47` post-set, verified through
  the same view, a fresh `Uint8Array(memory.buffer)`, and a fresh
  `DataView.getUint8`.  When `enc[0] === 0`, all three readbacks
  return 0.  So `mem.set` is fine — it's the source bytes that are wrong.
- The 21 native getcwd calls have `max_path_len ∈ {256, 4096}` in
  exactly the same distribution we see (3×256, 18×4096), and call
  count matches.  Layout matches; behavior diverges only at the JS
  bridge.

### Why prior attempts missed it

Same root cause as the [Edge mutates `globalThis` mid-run](#2026-05-20--edge-mutates-globalthis-mid-run)
entry already knew about (where `performance.now` got clobbered — fixed by
caching at module load in [worker.ts](browser-target/src/worker.ts) and
[trace.ts](browser-target/src/trace.ts)).  The fix was applied to
`performance` and `performance.now` but **not** to `TextEncoder`/`TextDecoder`,
so the encoder kept being re-resolved through `globalThis.TextEncoder`
per call.  The mem-snapshot / SAB-aliasing / view-staleness rabbit holes
were chasing the symptom (post-mutation writes look "wrong" relative to
expected cwd bytes) rather than the cause (encoder swapped).

### Proposed fix (NOT applied — review first per brief)

1. In [browser-target/src/wasi-shim.ts](browser-target/src/wasi-shim.ts),
   precompute the bytes for `FIXED_CWD` once at module load (or at
   `createWasiShim` entry, before the wasm runs).  Replace
   `const enc = new TextEncoder().encode(FIXED_CWD);` inside `getcwd`
   with a captured `Uint8Array` constant.  Example:

   ```ts
   // Capture before wasm bootstrap mutates globalThis.TextEncoder.
   const FIXED_CWD = "/";
   const FIXED_CWD_BYTES = new TextEncoder().encode(FIXED_CWD);
   ```

2. Audit all other `new TextEncoder()` / `new TextDecoder()` sites
   (grepped: `wasi-shim.ts:273, 282, 430, 442, 455, 468`,
   `napi-host/unofficial.ts:109, 112, 480, 497`).  Each one needs
   either:
   - Module-level capture of the constructor:
     `const NativeTextEncoder = globalThis.TextEncoder;`
     and use `new NativeTextEncoder()` everywhere.
   - Or one cached instance: `const encoder = new TextEncoder()`
     (which we already do for the decoder at `wasi-shim.ts:80`).

   The latter is the simpler pattern; matches what `wasi-shim.ts` already
   does for `decoder`.  Extend `captured` at line 84 to include
   `TextEncoder` and `TextDecoder` constructors — for any path that
   needs a fresh instance — plus a module-level `encoder` like the
   existing `decoder`.

3. Once fix is in, the existing `#!~debt instrumentation` block at the
   top of `getcwd` will show `isNative: true` and `encBytes: [47]` for
   ALL 21 calls, and the EIO will not fire.  Remove the instrumentation
   block then.

### What's still uncertain (low probability)

- Are there OTHER shims that use stale globals?  Likely yes:
  `Uint8Array`, `DataView`, `Atomics`, `Math.random` — edge may shadow
  any of these.  Worth a sweep, but doesn't block #14.  Add to follow-up.
- The exact native vs polyfill toString of the post-mutation
  `TextEncoder` isn't captured (`isNative: false` is all we have).
  Could be edge installing a primordials-frozen polyfill, could be
  a Node.js `util.TextEncoder` analog.  Not load-bearing for the fix.

### #!~debt added (one block, still in place)

- `browser-target/src/wasi-shim.ts:540`-ish, the `[diag-getcwd encoder]`
  postLog and the `getcwdCallIdx` counter at line ~125.  Both keep the
  bug visible for re-runs.  Remove once the fix lands and is validated.

### Path forward

1. Apply the cached-TextEncoder fix (see above).
2. Rerun browser; confirm 21 getcwd calls all log `isNative: true`,
   no EIO thrown.
3. Sweep remaining `globalThis`-resolved APIs for similar exposure
   (deferred unless symptoms surface).
4. Mark #14 complete, remove the `#!~debt instrumentation` block.

---

## 2026-05-20 — #!~debt uv_cwd EIO: attempt #5 (diagnose only — Hypotheses A/B tested)

Diagnostic-only attempt — no fixes shipped, no changes to wasi-shim.ts or
mem-snapshot.ts.  Two diagnostics were added under
[browser-target/src/diagnostics/](browser-target/src/diagnostics/):

- `sab-view-aliasing.ts` — pure-JS isolated repro for the Hypothesis A
  scenario (Chrome SAB view caching aliases stale views).  Constructs
  a `WebAssembly.Memory({shared:true})` with the same 337 initial pages
  edge uses, writes a marker through one `new Uint8Array(memory.buffer)`,
  reads back through six independent view constructions
  (`Uint8Array#1/2`, `DataView.getUint8`, `Uint8Array(buf,off,1)`,
  `Atomics.load(Int8Array)`, `subarray`).  Includes a `memory.grow(5)`
  scenario that exercises post-grow buffer-identity changes.
  Page URL: `http://127.0.0.1:5180/?diag=sab-aliasing`.
- `byteLength-watcher.ts` — wraps host import namespaces and logs every
  `memory.buffer.byteLength` and SAB-identity change observed across
  the bootstrap.  Used to test Hypothesis B (memory grows during boot,
  some cached buffer reference goes stale).
  Page URL: `http://127.0.0.1:5180/?diag=bytelen`.

Both are wired through `?diag=...` URL params + a worker-side gate
(`runDiagnosticsFirst`, `watchByteLength` in
[browser-target/src/worker.ts](browser-target/src/worker.ts)).

### Hypothesis A — Chrome SAB view aliasing

NOT supported.  Pure-JS repro across 35 probes spanning pages 330-341,
including post-grow scenarios with explicit buffer-identity change, shows
**zero misses** across six independent read paths.  Writes through one
`new Uint8Array(memory.buffer)` are immediately visible through any other
freshly-constructed view, a `DataView`, an `Atomics.load` on `Int8Array`,
and a `subarray` of a parent.

Output captured at the address range of the real failure
(`__heap_base = 22060144`, page 336+) — same allocation size, same
memory model, same access pattern as `wasi-shim.ts:getcwd`
(`mem.fill(0, bufPtr, bufPtr + maxLen)` then `mem.set(enc, bufPtr)`).
All reads see all writes.

This DOES disprove the "Chrome 148 caches the ArrayBuffer wrapper per
view-construction" speculation from attempt #4's notes.  Cross it off.

### Hypothesis B — Stale buffer reference (memory.grow + cached SAB)

Observed but NOT proven causal.  The wasm DOES call `memory.grow`
multiple times during bootstrap; 4 byteLength-change events fired
across ~175 instrumented calls, with final size 22872064 (= +12
pages from initial 22085632).  One of the change events coincides
with a `wasix_32v1.getcwd` call (#168 in the call sequence, len at
that moment = 22675456).

But: code audit shows zero JS-side caches of `memory.buffer`.  Every
read goes through `new Uint8Array(memory.buffer)` / `new DataView(
memory.buffer)` constructed at the call site.  Files checked:

- `wasi-shim.ts` — `view()` and `bytes()` reconstruct per call.
- `mem-snapshot.ts:32` — `snapshot()` reconstructs per call.
- `napi-host/unofficial.ts:22,101,259,275,283,287` — reconstructs per call.
- `napi-host/instance-proxy.ts` — no memory access.
- `@emnapi/core/dist/emnapi-core.esm-bundler.js` — every HEAP access
  reconstructs from `wasmMemory.buffer`.  Verified across ~40 sites.
- `worker.ts:79` — only reads `memory.buffer.byteLength` once at startup.

Crucially: scenario 2 of the SAB-aliasing test also probed whether a
pre-grow Uint8Array view sees post-grow writes at low addresses.  It
does.  Per spec, SAB-grow extends the same underlying memory; stale
view objects still read/write the same bytes.  So even if some code
held a stale reference, writes would still be visible.

### What attempt #4 actually observed

Attempt #4 reported that `mem-snapshot`'s `after` capture on the LAST
getcwd shows zeros (no `0x2f`), while the shim's in-shim readback
showed `0x2f` at the same address through 3 read paths.

Given Hypothesis A is disproven and Hypothesis B can't account for the
discrepancy under our access patterns, the most likely explanation is
that **the attempt #4 observation was a measurement artifact** of
`mem-snapshot.ts`.  Candidates:

1. The snapshot's `arg0` interpretation (treating any arg ≥
   `ptrThreshold=65536` as a pointer) might have snapshotted the WRONG
   address for the failing call.  The wasix getcwd ABI is
   `(bufPtr, bufSizePtr)` — both args ARE pointers.  `before/after.arg0`
   centers on `bufPtr`, which should be correct.
2. The snapshot's range-truncation (`if (ptr < range) ptr = range`)
   doesn't apply at high addresses.
3. The `[before, after]` text was inspected manually — possibly the
   wrong call's record was read.  21 getcwd calls means 21 snapshots,
   each ≈128 hex chars; easy to misalign in a busy trace.

Without rerunning attempt #4's exact comparison side-by-side with the
in-shim readback, we can't fully rule the artifact theory in or out.
But the pure-JS isolation strongly suggests the wasm's view of memory
is consistent with our writes.

### Conclusion

The EIO source is NOT a memory write-visibility issue.  The shim's
writes land, are visible to wasm, and survive across `memory.grow`.
This shifts probability mass to:

- Hypothesis C (untested this attempt): the wasm reads through a
  different mechanism we don't see — e.g., a struct member set by
  `uv_cwd` that we're not writing.  The exact failure site is known:
  func[6035] block J at offset `0x11fb60`-`0x11fb7d`, which sets
  `*err_out = -29` when `std::string::empty()` is true after the
  resize to `*size_ptr`.  This implies `*size_ptr` was being read as 0
  during the resize, OR the `std::string` got corrupted between
  resize and empty check, OR the shim's `bufSizePtr` write
  (`dv.setUint32(bufSizePtr, enc.length, true)`) isn't landing
  where uv_cwd expects.
- Hypothesis D (untested): something else zeros the buffer after the
  syscall.

**Recommended next attempt**: test Hypothesis C concretely.  Three
parallel paths:

1. **Read uv_cwd's caller frame layout via `wasm-tools print`.**  Find
   what offset `*size_ptr` is at relative to `uv_cwd`'s stack frame.
   Verify our `bufSizePtr` matches that offset (the wasm passes us
   the address — if its caller is reading a DIFFERENT address as
   `size`, the write goes to dead space).
2. **Instrument the bufSizePtr write specifically.**  Right after
   `dv.setUint32(bufSizePtr, enc.length, true)`, read it back via
   the same dv to confirm `enc.length` lands.  Cross-check with a
   fresh DataView too.  We already do similar in-shim readback for
   the cwd bytes; mirror it for the length out-param.
3. **Pre-zero `bufSizePtr+4` through `bufSizePtr+8`** to cover off-by-one
   misalignment by the caller (in case it reads `*(u32*)(bufSizePtr+4)`
   for the length instead of `*(u32*)bufSizePtr`).

If all three rule out (1)-(3), attempt #6 should pivot to the band-aid
paths catalogued in attempt #4: wasm-tools mutate to short-circuit the
EIO synthesis in func[6035] block J, or hijack `napi_create_error` to
no-op the throw.

### #!~debt added

- `sab-view-aliasing-diagnostic` (browser-target/src/diagnostics/sab-view-aliasing.ts)
  — diagnostic-only file; gated behind `?diag=sab-aliasing`.  Adds zero
  runtime cost when the URL param isn't set, but the file is dead code
  on the normal path.  Delete once #14 is unblocked AND we're confident
  Hypothesis A won't resurface for a similar memory-related bug.
- `bytelen-watcher-diagnostic` (browser-target/src/diagnostics/byteLength-watcher.ts)
  — diagnostic-only file; gated behind `?diag=bytelen`.  Same lifecycle.

---

## 2026-05-20 — FileSystem facade + bundled adapter (chunk 1 of browser fs)

Stood up a project-owned FileSystem interface and a `bundled` adapter that
serves real bytes for `/node-lib/**` and `/node/deps/**` from the page
origin via sync XHR.  Replaces the previous "every path → ENOENT" path in
the shim.

New files:

- [browser-target/src/host/fs/types.ts](browser-target/src/host/fs/types.ts)
  — `FileSystem` interface, `FsResult<T>` discriminated union, `FsErrno`
  (WASI-compatible values), `FileType`, `FileStat`, `DirEntry`,
  `OpenOptions`.  Sync, path-first, handle-based, read-only by default.
- [browser-target/src/host/fs/adapters/bundled.ts](browser-target/src/host/fs/adapters/bundled.ts)
  — adapter that fetches `/node-lib/**` and `/node/deps/**` via
  synchronous XMLHttpRequest from the worker.  Body + stat caches keyed
  by absolute path.  Only file in the codebase that knows about HTTP /
  bundled-content URLs.

Wiring in [browser-target/src/wasi-shim.ts](browser-target/src/wasi-shim.ts):

- `path_open`, `path_open2` route through `ctx.fs.open()` for any path
  other than `/dev/{urandom,random}`.
- `fd_read` checks `vfd.fsHandle` and routes through `ctx.fs.read()`.
- `fd_close` releases the FS handle.
- `fd_filestat_get` uses `ctx.fs.fstat()` for FS-backed fds.
- `path_filestat_get` tries `ctx.fs.stat()` first, falls back to the old
  heuristic (still `#!~debt fake-fs-fallback`).
- Helpers `readPath`, `isVirtualUrandom`, `openVirtualUrandom`,
  `openViaFs`, `writeFileStat` deduplicated.

Cleanup:

- `chdir` is now a no-op returning SUCCESS.  Previously referenced the
  removed `currentCwd` variable.  Wasi-libc owns `__wasilibc_cwd`; this
  syscall doesn't update it.

`browser-target/public/node/deps` is a symlink to the repo `deps/` tree
so Vite serves the full deps lazily (no bundling cost — Vite only reads
files actually requested).

### Verification

Reloaded `http://127.0.0.1:5180/`.  Result:

```
[wasi] path_open2 /node/deps/undici/src/package.json → fd 107 (fs)
[bundled-fs] HEAD /node/deps/undici/src/package.json → 200 (6044B)
[bundled-fs] GET  /node/deps/undici/src/package.json → 200 (6044B)
```

Success criterion hit: one path_open2 for a `/node/deps/...` path now
returns SUCCESS instead of errno=44 NOENT.

EIO from `uv_cwd` still surfaces — anticipated.  This chunk was about
opening the path; the EIO is in a different code path (libc cwd cache).

### Discoveries / things to triage

- Edge does NOT request `/node-lib/**` paths during the current
  bootstrap.  The compiled-in builtin catalog handles those.  The brief's
  hypothesis ("bootstrap can't load its own scripts") is wrong; bootstrap
  is loading them through the napi/V8 bridge, not WASI.
- ENOENT paths still hit: `/usr/local/ssl/openssl.cnf`,
  `/test/node_trace.1.log`, `/test/fixtures/tz-version.txt`,
  `/node/config.gypi`.  All match native behavior — edge probes,
  ENOENTs, continues.  Not blocking.
- `bodyCache` and `statCache` in the bundled adapter aren't bounded.
  Fine for known-small bootstrap manifest; unbounded for userland
  reads.  Will need eviction for long-running apps.

### #!~debt added

- `sync-xhr-network-blocking` (bundled.ts) — sync XHR blocks the wasm
  thread for the duration of any cold-cache fetch.  Fine on LAN dev;
  bad for production / slow networks.  Real impl: prefetch via async
  before `_start`, OR move FS to a separate worker w/ SAB+Atomics.
- `no-write-support` (bundled.ts) — `open(write:true)` always returns
  ROFS.  Userland `fs.writeFileSync` on `/tmp` etc. fails.  Needs OPFS
  adapter (future chunk).
- `no-readdir` (bundled.ts) — `readdir()` returns NOTDIR.  Vite has no
  directory listing endpoint and we'd need server-side manifest.
  Bootstrap doesn't readdir; userland will fail.
- `naïve-stat-via-fetch` (bundled.ts) — stat uses HEAD; no mtime/ctime
  propagation (symlink ctimes from disk are wrong anyway).
- `fake-fs-fallback` (wasi-shim.ts path_filestat_get) — paths the FS
  doesn't recognize still report success via the old heuristic.  Kept
  to avoid breaking libc cwd probes that worked before this chunk;
  remove once adapters cover the full path tree.

---

## 2026-05-20 — All 80 unofficial_napi_* now have named impls (#9 + #12)

Filled the remaining 67 in [browser-target/src/napi-host/unofficial.ts](browser-target/src/napi-host/unofficial.ts).
Every entry is marked `#!~debt` because most are best-effort no-ops with
sensible out-param writes; only a handful (`structured_clone`,
`get_constructor_name`, `get_own_non_index_properties`, `preview_entries`,
`contextify_run_script`, `arraybuffer_view_has_buffer`) do meaningful work
backed by browser JS.

Categories:

- **Heap / process / profiling stats** — return zeros; honest for "no V8".
- **Continuation-preserved embedder data** — single per-env slot, round-trips.
- **Promise introspection** — reports pending state, no result.
- **Stack inspection** — returns empty arrays/null.
- **Buffer / ArrayBuffer helpers** — real impls where browser JS suffices.
- **Structured clone family** — uses `globalThis.structuredClone()` with
  JSON fallback; transfer list dropped.
- **Serdes** — JSON-encoded ArrayBuffer roundtrip.
- **Contextify (vm.*)** — `make_context` returns marker, `run_script` evals
  via `new Function(...)`, `contains_module_syntax` is a naïve regex.
- **module_wrap_*** (18 funcs) — return handles that round-trip but don't
  execute.  ESM workloads will fail at link/evaluate; CJS boots fine.

Trace confirms: napi-host now seeds **231 entries** (was 164), zero STUB
fallback calls during edge boot.  Bootstrap timing unchanged (~83ms to EIO).

To promote a given stub to a real impl: pick one with `#!~debt` markers,
cross-reference the Rust behavior in `napi/src/guest/napi.rs`, and ideally
add a regression test asserting the trace's `fields.arg*` / `fields.ret`
matches native.

---

## 2026-05-20 — Service Worker HTTP bridge scaffolded (#5)

The wiring is in place: page registers `/sw.js`, sets up a `MessageChannel`,
hands one port to the SW and the other to the dedicated worker.  `/_edge/*`
fetches from anywhere in the page get intercepted by the SW, forwarded
through the port to the worker, dispatched, and the response is returned.

Verified end-to-end with a 501 stub responder:

```
fetch('/_edge/test', { method: 'POST' })
→ { status: 501, body: "edge bridge stub — POST /test\n#14 must unblock first" }
```

Components:

- `browser-target/public/sw.js` — SW with `/_edge/*` interceptor + port bookkeeping
- `browser-target/src/main.ts:setupBridge()` — registers SW, exchanges ports
- `browser-target/src/worker.ts:onBridgeMessage()` — receives `edge-req`,
  replies with `edge-res`

#!~debt stub responder: real impl needs to dispatch to a JS-side handle on
the running edge instance (probably an emnapi-exposed callback or a virtual
loopback socket pump).  Wait for #14 unblock first.

---

## 2026-05-20 — napi/ submodule patches preserved (#19 done)

`git submodule update` would obliterate the local mods in `napi/`.  Fixed by
exporting the diff to `patches/napi/*.patch` and adding `scripts/setup-napi-patches.sh`.

Reset / re-init flow:

```
git submodule update --init napi
./scripts/setup-napi-patches.sh
```

To regenerate after further local edits:

```
cd napi && git diff HEAD -- . ':(exclude)Cargo.lock' \
  > ../patches/napi/0001-edgejs-local-mods.patch
cd napi && git diff HEAD -- Cargo.lock \
  > ../patches/napi/0002-cargo-lock.patch
```

Pinned upstream commit: `1bcbf131187cb165053c615f6171eb58512b8014`.  Patches
contain:

- `--trace-wasi` flag + `JsonlTraceLayer` (src/bin/napi_wasmer.rs + new src/cli/)
- Permissive `NapiVersion::is_compatible_with` (src/lib.rs)
- Namespace merge + structured_clone 3-arg adapter + compile_function CJS
  adapter (src/guest/napi.rs)
- ctx + Cargo.{toml,lock,standalone.toml} bookkeeping

Verified end-to-end: stashed local mods → `git apply --check` clean → script
re-applied successfully → tree matches pre-stash state.

---

## 2026-05-20 — #!~debt uv_cwd EIO: attempt #4 (pre-seed `__wasilibc_cwd`) — N/A, did not unblock

The brief proposed pre-seeding `__wasilibc_cwd` from the host before
`_start` to bypass a broken init path.  Investigation killed the
hypothesis: **this wasm has no `__wasilibc_cwd` symbol** (or any cwd
cache global) at all.  Disassembling the libc `getcwd` wrapper:

- `func[1809]` (libc getcwd) calls `func[294]`, which is just a 3-line
  passthrough to `wasix_32v1.getcwd`.  No internal cache, no static
  state read.  On non-NULL buf, no malloc-retry path either.
- `wasm-tools dump` + `strings` confirm the symbol `__wasilibc_cwd`
  does not appear anywhere in the wasm.  No `__init_cwd` export.
- The `name` custom section is stripped; we have DWARF sections but
  no `llvm-dwarfdump` installed to walk them quickly.

So there is no host-side bytes to write.  Approach abandoned.

What I learned from the disassembly walk that the prior attempts did
not have:

- **The exact failure site is func[6035] (`TryGetCurrentWorkingDirectoryString`)
  → block J at 0x11fb60.**  Sets `*err_out = -29` (UV_EIO) when, after
  `uv_cwd` returned 0 and the local `std::string` was `resize`d to the
  returned length, `std::string::empty()` reports true.  Then func[5988]
  reads that -29 and calls func[6036] which builds the napi error.
- **The 21 getcwd calls in the trace are 21 SEPARATE process.cwd()
  invocations**, not loop retries on ENOBUFS.  Each call has a different
  caller stack frame (different `bufSizePtr`).  uv_cwd's internal retry
  on ENOBUFS would re-use the same bufSizePtr; we see all-different ones.
- **The mem-snapshot for the LAST getcwd call (the one immediately
  followed by the EIO build) shows `arg0` unchanged after the call**
  (all zeros, no `0x2f`).  But an in-shim readback via three independent
  paths (`dv.getUint8`, `new Uint8Array(buffer)[i]`, `new DataView(buffer)
  .getUint8(i)`) all confirm the `0x2f` IS at `bufPtr` at the moment the
  shim returns.  So the byte IS there; the mem-snapshot's `after` view
  on `memory.buffer` is reading something different.  This is the same
  one-time anomaly noted in `mem-snapshot.ts` (see `#!~debt
  unverified one-time anomaly`) — except not actually one-time.  It
  reliably misses on calls whose `bufPtr` lands in pages allocated
  after `__heap_base` (= 22060144), which only got *written* via the
  shim, never via the wasm.  Hypothesis: Chrome 148 caches the
  ArrayBuffer wrapper returned by `memory.buffer` per Uint8Array
  construction, and SharedArrayBuffer accesses miss writes that
  happened on a different cached wrapper.  Not chased further.

- **The EIO synthesis path inside the wasm requires `std::string::empty()`
  to be TRUE on the local buf.**  The buf was just constructed with
  `(256, '\\0')` (so size=256), then resized to whatever `*size_ptr` is
  after uv_cwd (= strlen of buf, which is 1 for "/").  So size should
  be 1, not 0.  Either: (a) `*size_ptr` is being read as 0 by the resize
  path, or (b) resize(1) results in `empty() == true`, or (c) something
  trashes the string between resize and empty().
- I did not chase to a definitive answer for which of (a)/(b)/(c)
  applies.  Each would require either symbol-name recovery (we don't
  have one) or wasm instrumentation (`wasm-tools mutate`) — both bigger
  asks than the 60-min budget for this attempt.

### Unblock paths still NOT tried, in priority order

1. **`#!~unblock` Patch the wasm with `wasm-tools mutate` / hex-edit
   to short-circuit func[6035] block J** (the "size==0 → set EIO"
   gate at 0x11fb60-0x11fb7d).  We know the exact byte range.  Even
   just NOP-ing the `i32.store 2 0` of `-29` at 0x11fb75 would prevent
   the EIO synthesis (the result would then be whatever the next path
   sets).  This is a band-aid but cheap.
2. **`#!~unblock` Hijack `napi_create_error`** at the host to detect
   the "EIO/uv_cwd" pattern and replace it with no-op so the throw
   path becomes a no-op return.  Edge would then proceed with an
   empty cwd; downstream code probably falls back to "/" or "".
3. **`#!~unblock` Diagnose the mem-snapshot/readback discrepancy
   first.**  If the shim's writes really aren't visible to the wasm
   (despite being visible to the shim's own re-read), that's the
   root cause and the buffer/SAB grow handling needs fixing.  The
   discrepancy might be a Chrome bug; would need an isolated repro.

Did NOT change any code as part of this attempt (the byte-by-byte
DataView write was tested and reverted — it didn't help, but it
proved the in-shim readback always succeeds).

---

## 2026-05-20 — #!~debt uv_cwd EIO: 3 attempts exhausted, parked

After three more attempts past the previous narrowing, EIO still surfaces
from `wrappedCwd` at bootstrap.  Attempts:

1. **proc_id errno fix.** Trace showed `wasix_32v1.proc_id(0x150aa0c) -> errno=1`.
   The shim was returning 1 (the PID value) with no outPtr handling — wasm
   read 1 as `errno=EPERM`. Fixed in [wasi-shim.ts:proc_id](browser-target/src/wasi-shim.ts)
   to write pid via outPtr and return `SUCCESS`.  Real bug; did NOT unblock EIO.
2. **Source walk** (edge `TryGetCurrentWorkingDirectoryString` at
   `src/edge_process.cc:235`, libuv `uv_cwd` at `deps/uv/src/unix/core.c:753`).
   Confirms EIO synthesized when libc getcwd returns NULL or empty.  No new
   leverage from the C++ side.
3. **Zero-pad getcwd buffer** to `max_path_len` to match wasmer-wasix's
   `getcwd.rs:36-44` exactly (it writes a zero-padded `Vec<u8>` of size
   `max_path_len64`, not just the cwd bytes).  Our shim used to write only
   `cwd.length` bytes.  Did NOT unblock EIO.

What we know stays the same: the EIO is constructed *inside the wasm*, with
no host imports between the last bootstrap call and the throw.  This means
the failure is in libc-internal state (likely `__wasilibc_cwd` cache being
empty when `getcwd_legacy` reads it), set during a path we can't observe
without DWARF or wasm instrumentation.

Unblock paths we did NOT try (would be next session):

- `#!~unblock` Rebuild edgejs.wasm with a patched `TryGetCurrentWorkingDirectoryString`
  that doesn't synthesize EIO for empty cwd (or pre-seeds the cwd from an
  env var).  Requires wasixcc toolchain.
- `#!~unblock` Use `wasm-tools` to instrument `wasm-function[5988]` (the C++
  ProcessCwd binding) and observe the actual libc getcwd return.
- `#!~unblock` Try setting `WASI_FS_ROOT` or other wasix-libc env vars that
  short-circuit cwd resolution.

Parking with `#!~debt` markers in code and this NOTES entry.

**Update (attempt #4):** investigated `__wasilibc_cwd` host pre-seed
hypothesis from the brief.  Confirmed `__wasilibc_cwd` does not exist
in this wasm — libc getcwd is a passthrough to `wasix_32v1.getcwd`.
See the new entry above for the precise EIO synthesis site
(func[6035] block J at 0x11fb60) and the ranked unblock options.

---

## 2026-05-20 — uv_cwd narrowed further but still open

Using the upgraded harness:

- **Comparative diff caught two real bugs** — missing `.` preopen (fd 4) and
  third `/` preopen (fd 5).  Browser now matches native on preopens.
- **Memory snapshots confirm our `getcwd` write lands** — bytes at `bufPtr`
  show `0x2f` ('/') after our `mem.set`, exactly as expected.  False alarm on
  earlier "no write" observation (memory state was tracked correctly).
- **Errno-proxy shows zero `EIO` (29) returns** from any of our syscalls.
  Everything we return is `0`, `8 (BADF)`, `44 (NOENT)`, or `1` (pid).

But edge still throws `EIO: process.cwd failed`.  The trace shows a ~16ms
window between the last syscall (`proc_id` returning the pid) and `proc_exit2(1)`
where edge does pure C++/JS work — *no host imports*.  That means errno=29
is being set by libc *internally*, not via any syscall return we control.

Hypothesis (per wasix-libc source review):

- `__wasilibc_cwd` (the libc-internal cwd cache, type `char*`) might be
  ending up as `""` (empty string) somehow.  Then libc's getcwd_legacy
  would return a zero-length string.  uv_cwd reads strlen → 0.  Edge's
  `TryGetCurrentWorkingDirectoryString` then synthesizes UV_EIO when the
  resulting `cwd` string is empty (`src/edge_process.cc:250`).

- Or one of these wasix-libc functions sets `errno = EIO` directly without
  going through a syscall (grepped, found these):
    - `libc-bottom-half/sources/getentropy.c:8`     (if len > 256)
    - `libc-top-half/musl/src/misc/getentropy.c:13` (if len > 256)
    - `libc-top-half/musl/src/aio/lio_listio.c:30`
    - `libc-top-half/musl/src/passwd/nscd_query.c`
    - `libc-top-half/musl/src/passwd/getgrouplist.c`

- libuv's `uv__random_readpath` opens `/dev/urandom` and reads — but if our
  fd_read returns short, libuv might surface EIO.  We do have /dev/urandom
  wired (verified earlier).

Next attack vector: figure out the wasm function at `wasm-function[5988]`
which the EIO stack points to.  That's the actual source.  Without DWARF
for edge code we'd need byte-pattern matching against the wasm or
instrumented rebuild.

Pragmatically, the unblock is probably:
1. Rebuild edgejs.wasm with `validate_openssl_csprng = false` AND a one-line
   patch to `TryGetCurrentWorkingDirectoryString` removing the "empty cwd
   → UV_EIO" gate.  Requires wasixcc.
2. Or instrument the wasm with `wasm-tools` to hook `wasm-function[5988]`
   and report what it actually reads.

---

## 2026-05-20 — Harness upgrades shipped (comparative tracing + memory + errno + filter)

The harness now has four diagnostic capabilities it didn't before:

1. **Comparative tracing (native ↔ browser).**  `napi_wasmer --trace-wasi <path>`
   writes JSONL host-call records, schema-compatible with what the browser
   harness exports via the JSONL download.  `browser-target/scripts/diff-traces.mjs`
   walks both files and reports the first divergence (with context).
   This caught the missing `.` and `/` preopens within one diff run.

2. **Memory snapshots at call sites.**  Pass `?mem=symbol1,symbol2` in the
   page URL.  The wasi/wasix shim wraps those symbols to capture N bytes
   around each pointer argument both before and after the call, attached
   to the trace under `fields.mem`.  Off by default — zero overhead when
   the URL param isn't set.

3. **Errno-proxy tracking.**  Trace summary includes a "non-zero wasi/wasix
   returns" section listing every syscall return that would set libc's
   errno, in chronological order.  Confirms which value was last set
   before any failure.  True `__errno_location` access isn't possible —
   the wasm doesn't export that symbol.

4. **Filterable trace UI.**  The harness page has a filter input that
   live-hides any log line not matching the substring.  Makes the 12k-call
   trace dump actually browsable.

### How to use comparative tracing

```bash
# 1. Native trace
napi_wasmer edgejs.wasm \
  --builtin-js-dir /tmp/edgejs-unpacked/lib \
  --trace-wasi /tmp/native.jsonl \
  -- -e "console.log('x')"

# 2. Browser trace — open http://127.0.0.1:5180/, wait for run to finish,
#    click "download JSONL (diff vs native)".  Or via agent-browser:
agent-browser eval "(async()=>{const a=document.querySelector('a[download*=jsonl]');return (await fetch(a.href)).text();})()" \
  | jq -r . > /tmp/browser.jsonl

# 3. Diff
node browser-target/scripts/diff-traces.mjs /tmp/native.jsonl /tmp/browser.jsonl
```

### What it cost to find via this harness vs prior approach

The "`.` preopen missing on browser" finding would have taken hours of
guessing-and-rebuilding without the diff.  With the harness, it took one
run.  Same for the env-vars-empty matching — visible in the diff at
position #1.

---

## Tech debt catalog

Every entry here corresponds to a `#!~debt` comment in the code.  When you
fix one, remove the marker AND the catalog row.  Grep for `#!~debt` to find
every site at once.

### Auto-generated stub fallback (`src/imports-generated.ts` via `scripts/gen-stubs.mjs`)

The generator emits one entry per host import: uses an override if we
provide one, otherwise a namespace-default-return stub.  Coverage today
(produced from `imports-*.txt` and `src/wasi-shim.ts` / `src/napi-host/`):

| Namespace | Edge imports | Real impls | Default-return fallbacks |
|---|---|---|---|
| `wasi_snapshot_preview1` | 37 | ~15 | ~22 (return 52 ENOSYS) |
| `wasix_32v1` | 46 | ~10 | ~36 (return 52 ENOSYS) |
| `napi` (standard) | ~100 | ~100 (via emnapi) | 0 |
| `napi` (unofficial) | 80 | 13 | 67 (return 0 = napi_ok — *lies success*) |
| `env` | 7 | 7 (real stubs returning zeros) | 0 |
| `wasi.thread-spawn` | 1 | 0 | 1 (returns -1) |

The 67 unofficial_napi_* fallbacks are the biggest correctness risk:
returning `napi_ok` without doing anything causes the wasm to think the
operation succeeded when it didn't.  Trace will show no STUB because
they're "implemented via fallback," but they're functionally broken.

Task #12 was marked complete based on "no STUB in current trace" — that
was true but only because edge's boot path only exercises 13 of the 80.
A more complete run will surface the rest, one at a time.

### Browser host — napi extensions (`src/napi-host/unofficial.ts`)

- `unofficial_napi_set_enqueue_foreground_task_callback` — no-op.  Should
  wire to `queueMicrotask`/`postMessage` so async work and timers actually
  fire.  Anything depending on the event loop (timers, async I/O callbacks)
  is broken until done.
- `unofficial_napi_set_fatal_error_callbacks` — no-op.  Fatal errors
  surface only via JS throw, not via these callbacks.
- `unofficial_napi_set_prepare_stack_trace_callback` — no-op.  Browser's
  default stack format used instead of node's V8 customization.  Cosmetic
  until userland relies on V8 stack shape.
- `unofficial_napi_set_promise_hooks` — no-op.  `async_hooks` won't see
  init/before/after/resolve events.
- `unofficial_napi_get_error_source_positions` — no-op.  Stack frames lack
  precise column info.
- `unofficial_napi_get_proxy_details` — always reports "not a Proxy".
  Anything inspecting Proxy internals via napi gets wrong answer.
- `unofficial_napi_release_env` — no-op.  Created emnapi envs / scopes
  accumulate (don't actually release).  Fine for single shots; leaks for
  long sessions.
- `unofficial_napi_contextify_compile_function` — uses `new Function` as
  V8 `vm.compileFunction` approximation.  Drops `parsingContext`,
  `contextExtensions`, `cachedData`, `produceCachedData`.  Compile errors
  return status 1 instead of populating the napi pending-exception slot.

### Browser host — emnapi instance proxy (`src/napi-host/instance-proxy.ts`)

- `free` — no-op.  `unofficial_napi_guest_malloc` allocates from wasm
  heap with no paired guest_free, so every emnapi-side malloc leaks
  until the wasm itself dies.  Negligible during boot, unbounded for
  long-running sessions / large buffer churn.
- `napi_register_wasm_v1` proxy stub — returns 0 so emnapi's init
  flow completes.  edge isn't a napi-rs addon; this just satisfies
  emnapi's instance-check.  Not visibly broken but worth noting.

### Browser host — WASI shim (`src/wasi-shim.ts`)

- `poll_oneoff` — returns "0 events ready" immediately.  Blocks setTimeout
  from firing, breaks any FD-readiness wait.  Needs SAB+Atomics.wait or
  proper Worker scheduling for real impl.
- `fd_pipe` — allocates a pair of virtual fds but they aren't actually
  connected.  Writes are accepted-and-discarded; the read side never sees
  data.  Real pipe semantics need a shared ring buffer.
- `path_filestat_get` (fallback branch) — `fake-fs-fallback`: when the FS
  facade returns NOENT, the shim still reports success with a "trailing
  slash → dir / else file" heuristic.  Kept to avoid regressing libc
  cwd / fixture probes that worked before adapters existed.

### Browser host — FileSystem (`src/host/fs/adapters/bundled.ts`)

- `sync-xhr-network-blocking` — cold-cache reads block the wasm thread
  for the duration of a network RTT.  Fine for LAN dev (<1 ms); bad for
  prod / slow networks.  Real impl: prefetch via async before `_start`,
  OR move FS to a separate worker addressed via SAB+Atomics.wait.
- `no-write-support` — `open(write:true)` always returns ROFS.  Tests
  and userland needing `/tmp` scratch will fail.  Needs OPFS adapter
  (future chunk).
- `no-readdir` — returns NOTDIR.  Vite has no directory-listing
  endpoint; we'd need a server-side manifest.  Bootstrap doesn't
  readdir; `fs.readdirSync` from userland will fail.
- `naïve-stat-via-fetch` — stat uses HEAD; no mtime/ctime propagated.

### Worker (`src/worker.ts`)

- Hard `CALL_LIMIT` of 20,000 imports per run as a runaway-loop circuit
  breaker.  Crude — should be a watchdog timer or progress-based.

### Memory snapshot (`src/mem-snapshot.ts`)

- Unverified one-time anomaly: an earlier capture showed a `getcwd` write
  that didn't persist in the `after` snapshot.  Subsequent runs all show
  writes correctly.  Not reproducible at present.  If it returns, the
  marker is there — bisect from `mem.set` outwards.

### Diagnostics (`src/diagnostics/*`)

- `sab-view-aliasing.ts` — pure-JS isolated repro for the Hypothesis A
  scenario from attempt #5 of #14.  Tests whether Chrome aliases SAB
  views in a way that hides writes.  Verdict from 2026-05-20 run: NO,
  it doesn't.  Keep until #14 is closed and we're confident this won't
  resurface for a related bug.  Gated behind `?diag=sab-aliasing`.
- `byteLength-watcher.ts` — wraps host import namespaces to log every
  `memory.buffer.byteLength` change observed across the bootstrap.
  Used in attempt #5 of #14 to verify the wasm calls `memory.grow`
  during boot (it does; ~12 pages of growth).  Gated behind
  `?diag=bytelen`.  Keep alongside `sab-view-aliasing.ts`.

---

## Local submodule mods (not upstreamed)

The following files in the `napi/` submodule are modified locally.  A
`git submodule update --remote` or reset of `napi/` will lose all of these.
Re-apply order doesn't matter; each is independent.

### `napi/Cargo.toml` + `napi/Cargo.standalone.toml`

Added optional `tracing`, `tracing-subscriber` (env-filter feature), and
`serde_json` deps; pulled into the `cli` feature.  Required for the
`--trace-wasi` JSONL output.

### `napi/src/lib.rs:32-44` — `NapiVersion::is_compatible_with`

Made permissive: accepts `(V10, Unknown)` and `(Unknown, V10)` and
`(Unknown, Unknown)` (upstream only had `(V10, V10)` and `(Unknown, V10)`).
Required because the published `wasmer/edgejs` binary is built against a
newer napi protocol than `wasmerio/napi` main publishes.

### `napi/src/cli.rs` → `napi/src/cli/mod.rs`

Renamed file to enable submodule structure under `cli/`.  Same content,
just relocated.  `cli` is now a module directory.

### `napi/src/cli/trace_layer.rs` (new file)

JSONL trace layer for the comparative-tracing harness.  Captures every
`tracing` span matching `wasmer_wasix::syscalls::*` and writes one JSON
line per span close to a file.  Schema-compatible with the browser-side
trace dump.

### `napi/src/bin/napi_wasmer.rs`

Added `--trace-wasi <path>` flag that initializes a `tracing_subscriber`
with the JsonlTraceLayer.  Default-off — only active when the flag is
passed.

### `napi/src/guest/napi.rs` — four edits

1. **Namespace merge** (after `io.register_namespace(NAPI_MODULE_NAME, ...)`,
   before the extension namespace registration): clones each entry from
   `napi_extension_wasmer_namespace` into the `napi` module.  Required
   because newer prebuilt edgejs.wasm puts `unofficial_napi_*` under the
   `napi` import module rather than `napi_extension_wasmer_v0`.

2. **`guest_unofficial_napi_structured_clone_3arg`** (new function): a
   3-arg adapter for the older signature edge.wasm now expects, delegating
   to the existing 4-arg impl with `transfer_list = 0`.  The `napi`
   namespace registration for `unofficial_napi_structured_clone` is
   re-routed to this adapter; `_with_transfer` keeps the original.

3. **Three stub functions added**: `guest_stub_unofficial_napi_contextify_compile_function_for_cjs_loader`,
   `guest_stub_unofficial_napi_get_current_stack_trace`,
   `guest_stub_unofficial_napi_module_wrap_import_module_dynamically`.  The
   first one is a real adapter that builds the CJS params array and calls
   the regular `contextify_compile_function`; the other two are no-ops
   that return generic-failure status.

4. **`compile_function_for_cjs_loader` adapter** writes through the
   existing 12-arg `contextify_compile_function` with the 5 CJS wrapper
   param names (`exports`, `require`, `module`, `__filename`, `__dirname`).
   Returns the wrapper-object handle directly (don't re-wrap — the bridge
   already produces `{function, sourceURL, sourceMapURL, ...}`).

---

## Closed investigations / negative results

Things we tried that didn't pan out.  Logged so we don't re-walk these
paths.

- **Setting `PWD=/` in the wasi env** → no effect on uv_cwd EIO.
- **Setting `currentCwd = "/app"` instead of `/`** → no effect; reverted.
- **Looking for `RAND_seed` / `OSSL_*` / any entropy-seeding exports** to
  call from JS at boot → zero matches (all stripped from the wasm
  exports by the linker).  This is the reason we did the `/dev/urandom`
  virtual file route instead.
- **DWARF lookup for `EdgeValidateOpenSslCsprng` / other edge functions**
  via `llvm-dwarfdump --name=...` → DWARF is in the wasm but only covers
  compiler-rt, musl, and libc++ — *no* edge source debug info.
  Can't symbolicate stacks pointing to edge functions.
- **Stock `wasmer` CLI 7.1.0 + `--experimental-napi`** on the published
  `wasmer/edgejs` package → "Unsupported N-API import version: Unknown".
  Forced us to build `napi_wasmer` locally from the `napi/` submodule
  and apply the version-check patch.
- **`OPENSSL_CONF=/dev/null` / `RANDFILE=...` env vars** to influence
  OpenSSL init → no effect on the EIO path.
- **Searched `wasix-libc` for `errno = EIO` callers** → only five sites
  (two getentropy variants for len>256, aio_lio_listio, two passwd
  helpers).  None plausibly reached by uv_cwd.  Source of errno=29 is
  still unknown.
- **Tried `napi_wasmer` from origin/main of wasmerio/napi** → wasmer-types
  version conflict (7.2.0-alpha.2 vs 7.1.0).  Standalone build broken at
  HEAD.  Pinned at commit `1bcbf131` instead.

---

## 2026-05-20 — uv_cwd EIO confirmed NOT a write-visibility issue

Added a readback diagnostic in `wasix_32v1.getcwd` that reads memory
immediately after our `mem.set(enc, bufPtr)` write.  Confirmed the bytes
land where expected (`[getcwd] wrote "/" (1B) at addr ..., maxLen was ...`).

So the wasm CAN see our cwd write — yet edge's `TryGetCurrentWorkingDirectoryString`
still ends up reporting `UV_EIO` (errno -29, the WASI `__WASI_ERRNO_IO`
value).  Possible roots, in order of likelihood:

1. A *different* libc getcwd variant is being used than `libc-bottom-half/sources/getcwd.c`
   — there's also `libc-top-half/musl/src/unistd/getcwd.c` with `__wasilibc_unmodified_upstream`
   guards.  Linker might pick differently than we expect.
2. `errno` was set to 29 by some earlier syscall (one of the many
   path_open2 ENOENT probes?) and lingers; libc's getcwd may surface it
   even though OUR wasi_getcwd returned success.
3. Edge wraps `uv_cwd` in a chain that does extra validation we haven't seen.

Best next diagnostic: build `napi_wasmer` with extra logging around
`__wasi_getcwd` invocations and diff against browser.  Won't trace
through libc internals from outside.

---

## 2026-05-20 — All STUB host imports retired

After implementing 11 unofficial_napi_* functions (env lifecycle, V8 flags,
private symbols, contextify compile_function, foreground task callback,
fatal error callbacks, prepare stack trace callback, promise hooks, error
source positions, proxy details) **the trace shows zero `[STUB]` calls**.
Every host import is now either:

- An emnapi-provided standard `napi_*` implementation (~100 functions)
- A hand-rolled unofficial_napi_* in `browser-target/src/napi-host/unofficial.ts`
- A WASI/WASIX implementation in `browser-target/src/wasi-shim.ts`
- An intentional `return 0` no-op for callbacks we don't dispatch

Every napi or wasi NOSYS return is now an actual gap, not a forgotten stub.
This is the right baseline state for the next phase of work.

---

## 2026-05-20 — Primordials have no runtime toggle in edge.js

`internal/per_context/primordials` is executed unconditionally during
bootstrap at `src/edge_runtime.cc:2757`. No CLI flag, no env var, no
`RuntimeInitOptions` field controls it.

For WebContainer-style browser performance the cost is non-trivial. The
natural shape would be:

- Add `RuntimeInitOptions::execute_primordials = true` (parallel to
  `validate_openssl_csprng`).
- Wire `EDGE_SKIP_PRIMORDIALS=1` env var via `EdgeIsTruthyEnvVar`.
- Gate the `execute_bootstrapper("internal/per_context/primordials", ...)`
  call on that flag.
- ~5-line patch in `edge_cli.cc` + `edge_runtime.cc`.

Not blocked on this for the current path — primordials *do* run successfully
in our browser harness via the emnapi-backed
`unofficial_napi_contextify_compile_function`. Logging the question for
when we revisit perf.

---

## 2026-05-20 — CSPRNG validation has no runtime toggle either

`EdgeValidateOpenSslCsprng` (`src/edge_runtime.cc:3584`) calls `std::abort()`
unconditionally if `ncrypto::CSPRNG(nullptr, 0)` returns false.
`RuntimeInitOptions::validate_openssl_csprng` defaults to `true` and is never
set to `false` anywhere in the codebase.

Worked around in the browser by mounting a virtual `/dev/urandom` backed by
`crypto.getRandomValues` — mirrors what wasmer-wasix does natively per
`virtual-fs-0.701.0/src/builder.rs:97`. OpenSSL opens the file and reads
entropy through the standard WASI `fd_read` path; CSPRNG passes naturally.

Open question: should `validate_openssl_csprng = false` be the default for
WASIX target builds? Hosts that don't provide a virtual `/dev/urandom`
(which is many) hit this trip wire silently with `std::abort()`.

---

## 2026-05-20 — uv_cwd EIO under our browser shim only

After full Node bootstrap, `process.cwd()` throws
`EIO: process.cwd failed with error i/o error, uv_cwd`. Native
`napi_wasmer` passes the same checkpoint cleanly.

The fault is in edge's `TryGetCurrentWorkingDirectoryString` synthesizing
`UV_EIO` when `uv_cwd` returns success but the cwd buffer is empty
(`src/edge_process.cc:250`). Our `wasix_32v1.getcwd` is implemented
correctly: returns "/" + length 1.

Suspects (not yet investigated):

- A different wasi-libc internal path that doesn't go through our
  `wasix_32v1.getcwd` at this specific call site.
- An interaction with `__wasilibc_cwd_is_synced` / `__wasilibc_cwd`
  state where libc returns the global string instead of asking the host.
- Some other syscall in the chain returning success-with-empty.

Best diagnostic: run the same `console.log` script under native
`napi_wasmer` with WASI tracing on, diff the syscall sequence against the
browser trace — they should diverge at one specific call.

---

## 2026-05-20 — Crypto + TextDecoder reject SharedArrayBuffer views

In the browser, `crypto.getRandomValues` and `TextDecoder.decode` both
throw when given views backed by `SharedArrayBuffer`. Edge requires shared
memory (wasm-threads), so all WASM linear memory is SAB-backed.

Workaround in our shim: copy bytes into a fresh `Uint8Array` first, then do
the operation, then copy back to the shared buffer. See
`browser-target/src/wasi-shim.ts` `urandomFd()` and `random_get()`, and
`browser-target/src/napi-host/unofficial.ts` for the same pattern in
`unofficial_napi_create_private_symbol`.

Worth knowing: any future API that touches guest memory directly will hit
the same restriction.

---

## 2026-05-20 — `unofficial_napi_guest_malloc` is the host-allocator escape hatch

The edge wasm exports `unofficial_napi_guest_malloc(size: u32) → u32` so
the host can allocate guest-side memory for ArrayBuffer / TypedArray
bridging. No paired `unofficial_napi_guest_free` — allocations leak by
design until guest GC.

We wired this into our `napi-host/instance-proxy.ts` as emnapi's `malloc`.
Without this, emnapi's typed-array marshalling path crashes.

Already flagged in `wasix/WASIX_TODO.md` ("Revisit the explicit
`ubi_guest_malloc` export"). Long-term wants a cleaner guest allocator
contract, but the current escape hatch is doing real work for us today.

---

## 2026-05-20 — Edge mutates `globalThis` mid-run

Edge's bootstrap installs all the Node globals (`process`, `Buffer`,
`globalThis.primordials`, etc.) by writing onto `globalThis`. That includes
shadowing some host-provided properties.

In our worker we found `globalThis.performance` getting clobbered partway
through bootstrap, causing later `performance.now()` to throw "Cannot read
properties of undefined". Fix: capture native APIs at module load (before
the wasm runs) into local consts. See `browser-target/src/worker.ts:16` and
`browser-target/src/trace.ts:18`.

Generalize this: anywhere our host code uses a globalThis-accessible API
*across* a wasm call, cache the binding upfront.

---

## 2026-05-20 — Hardcoded developer paths in published wasm

The published `wasmer/edgejs` wasm has hardcoded paths from the build
machine baked into the binary, e.g.:

- `/home/amin/projects/work/edgejs/node/deps/undici/src/package.json`
- `/home/amin/projects/work/edgejs/test/fixtures/tz-version.txt`
- `/home/amin/projects/work/edgejs/node/config.gypi`

Edge probes these as fallbacks at startup; they all `ENOENT` cleanly and
bootstrap proceeds. Not blocking, cosmetic. When we own the build pipeline
we should pass a generic prefix (`/edgejs/...`) or strip the absolute
prefix at build time.

---

## 2026-05-21 — Rabbit-Hole snapshot (resolved)

Folded in from the former `RABBIT_HOLE.md`.  This was a pause-snapshot
captured mid-investigation when we'd surfaced four cascading bugs in
the buffer / microtask / stream pipeline.  Most have since been
resolved (see top-of-NOTES.md for current status).

# Rabbit-Hole Snapshot — 2026-05-21

> **UPDATE — evening of 2026-05-21**
>
> Bug #4 `buffer-from-string-zeroed` resolved STRUCTURALLY via new
> `buffer-wasm-aliased` policy (now in `minimalPolicies`).  Mechanism:
> (a) napi-host overrides `napi_create_external_arraybuffer` to register
> the handle as a `Uint8Array` view over `wasmMemory.buffer` itself
> (not a JS-heap `ArrayBuffer` with sync-table); (b) new
> `builtinOverrides` value shape `{ post: string }` lets us splice a
> small patch AFTER edge's bundled `internal/buffer.js` body, rewriting
> `createUnsafeBuffer` to use the 3-arg `FastBuffer(buffer, offset, len)`
> ctor (view, no copy).  Result: `buf.buffer === wasmMemory.buffer`,
> `buf.byteOffset === wasm_ptr`.  JS-side `buf[i]` and C++ writes touch
> the same byte.  Side effect: test suite is **~3× faster** because
> emnapi's redundant syncMemory copies are now bypassed.
>
> Bug #4 was the primary blocker for the `outbound-fetch-tunnel` test.
> That test now **PASSES** — was skipped, un-skipped.  Test suite: **14
> pass / 0 fail / 1 skip** (was 12/0/2).
>
> The older `buffer-write-sync` policy (wrap-Buffer.prototype.write,
> sync-via-no-op-napi-call) is retained in the registry as an
> alternative / diagnostic but NOT in defaults.
>
> Remaining debts from the original 4:
> - **#1 `sab-ab-body-read`** — still real for production use of edge's
>   bundled fetch / Response.  Mocked fetch in our tunnel test
>   sidesteps it.
> - **#2 `lazy-load-from-microtask`** — workaround in the
>   `outbound-fetch-tunnel` policy's prelude still active.  Root cause
>   not investigated.
> - **#3 `microtasks-starved-by-pending-timer`** — test-code-side
>   workaround (no setTimeout watchdogs) still in place.  Root cause
>   not investigated.
>
> New debts surfaced this session:
> - `buffer-wasm-aliased-policy-required` — buffer storage being the
>   SAB is now load-bearing; any code that assumed
>   `buf.buffer instanceof ArrayBuffer` will break.
>
> See [NOTES.md](./NOTES.md) for full debt entries.

----

You stopped here to come back later.  This file is the full context you need
to resume — what's outstanding, what we learned, what we tried, where things
sit, what the priorities are.  It's deliberately long.  Skim the Table of
Contents and dive into whatever's relevant when you return.

> **Where to start when you come back:**
> Read this file → skim [NOTES.md](./NOTES.md) → check `git log` for what
> happened after this snapshot → pick one item from "Pause Inventory" below.

## Table of Contents

1. [Project state at pause](#project-state-at-pause)
2. [Why we paused](#why-we-paused) — the rabbit-hole moment
3. [The 4 underlying bugs surfaced by fetch-tunnel](#the-4-underlying-bugs)
   - [#1 sab-ab-body-read](#1-sab-ab-body-read)
   - [#2 lazy-load-from-microtask](#2-lazy-load-from-microtask)
   - [#3 microtasks-starved-by-pending-timer](#3-microtasks-starved-by-pending-timer)
   - [#4 buffer-from-string-zeroed](#4-buffer-from-string-zeroed)
4. [Recommended investigation order](#recommended-investigation-order)
5. [Pause Inventory — what's outstanding](#pause-inventory)
   - [Half-done in this session](#half-done-in-this-session)
   - [Big chunks never started](#big-chunks-never-started)
   - [Smaller debts (52 `#!~debt` markers)](#smaller-debts)
6. [Architecture re-orientation](#architecture-re-orientation)
7. [Your stated rules (don't forget)](#your-stated-rules)
8. [Investigation toolkit — useful commands](#investigation-toolkit)

---

## Project state at pause

**Goal:** run unmodified edge.js (a Node-compatible runtime) inside a
browser via WebAssembly.  StackBlitz-grade Node compat.

**Branch:** `main`, ~24 commits ahead of `origin/main`.

**Last commit:** `c369dc61` — "policies: ship outbound-fetch-tunnel; test
skipped on 4 underlying debts"

**Test suite:** 12 pass, 0 fail, 0 error, 2 skip — via
`node browser-target/scripts/test-runner.mjs`.

**Capability matrix (see [NOTES.md](./NOTES.md) for full table):**

- ✅ Boot, console, process.exit, timers
- ✅ `http.createServer` + fetch roundtrip via SW bridge
- ✅ `crypto` (sha256, randomBytes, randomUUID, …)
- ✅ Module-source overrides (universal — bootstrap + lazy)
- ✅ TLS primitives + `https.createServer` + listen
- ✅ Policies DI framework with sane defaults
- ✅ Inbound HTTPS via SW bridge (https-as-http policy)
- ⚠️  Outbound HTTPS — `outbound-fetch-tunnel` policy SHIPPED but test
       blocked on the 4 bugs below
- ❌ `import` / ESM — never started (you asked to investigate `xnitro`
       in `../localwin` first)
- ❌ OPFS persistence (in-memory only)
- ❌ `worker_threads`, `child_process`

**Last several commits, newest first:**

```
c369dc61 policies: ship outbound-fetch-tunnel; test skipped on 4 underlying debts
0f103b74 policies: expose minimalPolicies + policyRegistry; clarify default lineage
b237e4b6 policies: extract a deployment-time strategy DI framework
5e09a346 overrides: bake https→http into the browser worker
949185a3 tests: add TLS/HTTPS smoke tests; document the roundtrip gap
94c6122f tests: add Node-side regression runner over tests/js/*
5188f64e napi: close override-bootstrap-only debt — intercept napi_run_script too
e9367aa8 napi: add universal module-source override hook (partial — bootstrap only)
332cb40b notes: reset NOTES.md to a curated scannable index, archive history
e3ad1153 fs: ModuleOverrides adapter — consumer-pluggable Node built-ins (scoped)
```

---

## Why we paused

You asked me to build the `outbound-fetch-tunnel` policy (the opt-in
shortcut for `http.request` / `https.request` over `globalThis.fetch`)
before consulting on ESM strategy.

The policy CODE turned out to be straightforward — wire `Writable` to
collect chunks, `await fetch(...)`, expose response as an EventEmitter.
But **getting it to actually run end-to-end uncovered four distinct
underlying compatibility bugs** in our edge.js+wasm host integration.

Each bug is independently real and affects more than just the fetch-tunnel.
They've been silently lurking — only this stress test surfaced them all.
Rather than keep patching workarounds and accumulating ugly polyfill code,
you said:

> "I'm hitting layers of underlying compatibility issues — we might have to
> pause and follow the rabbit hole on this"

That's right.  Each of these bugs deserves its own root-causing pass, not
a band-aid.

---

## The 4 underlying bugs

All four are documented as `#!~debt` markers in `NOTES.md` under
"Boot-blocking / correctness".  Below is the full context that wouldn't
fit in NOTES.

### #1 sab-ab-body-read

**Severity: High.** Affects any use of edge's bundled fetch / Response
in production browser deployment.

**Symptom:**
```
TypeError: Method get ArrayBuffer.prototype.byteLength called on
incompatible receiver #<SharedArrayBuffer>
```

**Minimal repro (Node harness):**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --quiet -e "fetch('http://x').then(r => r.text()).catch(e => console.log(e.message))"
```
Even `new Response('hi').text()` throws the same error.

**Why it happens:**

Our `patchEmnapiToUseWasmBackedBuffers` (in
`browser-target/src/napi-host/index.ts`) makes napi-created ArrayBuffers
backed by wasm memory.  Wasm memory IS a `SharedArrayBuffer` (we need
shared so multiple workers can read the same memory).

When V8/Node runs `ArrayBuffer.prototype.byteLength` on a value, it does
an internal check that the receiver is an `ArrayBuffer` instance (not
`SharedArrayBuffer`).  `byteLength` is a different getter on each class.

Edge's undici fetch internals read `byteLength` via the strict getter
(probably via `%ArrayBufferPrototype%.byteLength.call(buf)` or similar)
when consuming the response body.  Our SAB-backed buffer fails the check.

**What we tried:**
- Mocking fetch with a Response-shape object whose `arrayBuffer()`
  returns a regular `Uint8Array.buffer` (not SAB-backed).  Works for
  the tunnel's IN-process flow but doesn't help when REAL fetch fires
  in production.

**Where to investigate:**
- `browser-target/src/napi-host/index.ts` — search for
  `patchEmnapiToUseWasmBackedBuffers`, especially `napi_create_arraybuffer`
  and `napi_create_buffer` overrides.
- Decision point: should napi-created "ArrayBuffer" handles be:
  - Real `SharedArrayBuffer` (current — fast, no copy, but fails type checks)
  - Real `ArrayBuffer` with bytes copied from wasm memory (slower, but
    spec-compliant)
  - Some hybrid where we present as `ArrayBuffer` to userland but keep
    SAB underneath?
- May need to fork emnapi to handle this — its assumption is that wasm
  memory ArrayBuffer = real ArrayBuffer, which V8 in shared-memory mode
  violates.

**Blast radius:** Anyone using fetch, Response, Request, Blob, FormData,
TextDecoder over wasm-memory bytes, etc.  Probably explains other "silent
read failure" things we haven't noticed yet.

### #2 lazy-load-from-microtask

**Severity: Medium.** Visible whenever async user code uses console.log
with anything that touches lazy console internals.

**Symptom:**
```
TypeError: fn is not a function
    at BuiltinModule.compileForInternalLoader (node:internal/bootstrap/realm:401:7)
    at requireBuiltin (node:internal/bootstrap/realm:432:14)
    at lazyUtilColors (node:internal/console/constructor:84:18)
    at console.value (node:internal/console/constructor:332:17)
```
or with the same root, but from `createWritableStdioStream` →
`requireBuiltin('tty' | 'internal/fs/sync_write_stream' | 'net')`.

**Minimal repro:**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --policies buffer-pool-disable --quiet \
  -e "(async () => { await Promise.resolve(); console.log('a','b'); })();"
```

A bare `await Promise.resolve()` followed by multi-arg `console.log`
triggers it.  Single-arg console.log doesn't (different lazy path).

**What's happening:**

`realm.js:395`:
```js
const fn = compileFunction(id);
fn(this.exports, requireFn, this, process, internalBinding, primordials);
```

`compileFunction` is `internalBinding('builtins').compileFunction` which
in C++ is `BuiltinsCompileFunctionCallback` (edge_module_loader.cc:964).
That C++ callback calls our wasm-imported
`unofficial_napi_contextify_compile_function` — and we have a debug log
in there that **doesn't fire** when this error happens.

So either:
- C++ goes through a different path (cache?) we haven't traced
- Or the call from microtask context is somehow routed to a different
  napi function altogether

**Workaround in place (the silent-init prelude in
`outbound-fetch-tunnel.ts`):**

```js
// Pre-prime BEFORE any await microtask boundary:
process.stdout.fd; process.stderr.fd;  // forces createWritableStdioStream
const _w1 = process.stdout.write, _w2 = process.stderr.write;
process.stdout.write = () => true; process.stderr.write = () => true;
try { console.log('', ''); console.error('', ''); } catch {}
process.stdout.write = _w1; process.stderr.write = _w2;
```

This synchronously triggers lazyUtilColors + lazyInspect + stdio init
so that later microtask continuations find everything already cached.
Works but feels like a band-aid.

**Where to investigate:**
- `browser-target/src/napi-host/unofficial.ts` —
  `unofficial_napi_contextify_compile_function`.  Add an unconditional
  `console.warn` at the top to verify it's called or not from microtask
  contexts.  (Note: console.warn itself might hit the same bug — use
  `writeSync(2, ...)` directly.)
- The C++ side that calls our wasm import:
  `src/edge_module_loader.cc:964` `BuiltinsCompileFunctionCallback`.
  Trace what happens when invoked from `napi_call_function` inside a
  microtask.
- Possibility: emnapi's reference-counting / scope management drops
  some state across microtask boundaries that the C++ callback depends on.

**Why "fn = compileFunction(id)" can come back non-function:**
- `BuiltinsCompileFunctionCallback` returns the `.function` property of
  the compile result object.  If our hook didn't actually set that
  property (e.g. fell through to a stub returning 0), C++ extracts
  `undefined` and returns undefined to JS.
- Try logging on EVERY napi function in `imports-generated.ts` (turn the
  stub recorder into a tap) and look for what fires between the
  `await` and the `fn is not a function` throw.  The culprit napi call
  is probably visible.

### #3 microtasks-starved-by-pending-timer

**Severity: Medium-low.** Test-runner UX issue mostly; might mask other
bugs by making them look like timeouts.

**Symptom:** When a `setTimeout(N)` is pending, no microtasks drain
until the timer fires.  Async/await + setTimeout in the same script
always sees the timer first.

**Minimal repro:**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --quiet -e "
Promise.resolve().then(() => console.log('microtask'));
setTimeout(() => console.log('timer'), 1000);
"
```

In real Node: `microtask` then `timer`.  In our wasm: `timer` then `microtask`
(if `microtask` fires at all before the process exits).

**Why it likely happens:**

Edge's libuv-style event loop in wasm uses our `poll_oneoff` syscall
(`browser-target/src/wasi-shim.ts`).  When the loop has a pending
timer, it calls poll_oneoff with the timer timeout.  Our poll_oneoff
uses `Atomics.wait` against an SAB to block until the timeout OR a
wakeup signal.

**The bug is probably:** the wasm thread blocks on Atomics.wait WITHOUT
giving JS engine a chance to drain microtasks first.  JS microtasks
should drain BEFORE returning to the C event loop.

The JS engine's microtask queue is typically drained after every
"task" (event loop iteration).  In wasm running synchronously inside a
Worker, microtasks drain when the wasm yields back to JS (e.g. via an
import call) — but if the wasm just blocks on Atomics.wait without
returning to JS, microtasks never get scheduled.

**Where to investigate:**
- `browser-target/src/wasi-shim.ts` — find `poll_oneoff`.  Before calling
  `Atomics.wait`, try `queueMicrotask(() => {})` or `await Promise.resolve()`
  to force a microtask drain.  But you can't await inside a sync wasi
  call — that's the whole problem.
- Possible fix: in poll_oneoff, when the wait timeout is non-zero, do
  short Atomics.wait spins (e.g. 1ms each) and between spins yield via
  `setImmediate`/`postMessage` to allow microtask drain.  Tradeoff:
  CPU vs scheduling fidelity.
- Or: cooperate with the wasm such that any pending JS microtasks are
  injected as wakeup signals on the SAB.  Would need wasi-shim awareness
  of the JS microtask queue, which is hard (V8 doesn't expose it).

### #4 buffer-from-string-zeroed

**Severity: HIGH.** Silent data corruption.  Most concerning of the four.

**Symptom:** `Buffer.from('payload-here', 'utf8')` returns a Buffer of
correct LENGTH (12) but all-zero BYTES.  The string→utf8 encoding
**never actually writes into the buffer**.

**Minimal repro from the fetch-tunnel test session:**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --quiet --policies buffer-pool-disable,outbound-fetch-tunnel -e "
const req = require('http').request({method:'POST'});
req.write('payload-here');
console.log('chunks:', req._chunks.map(c => [c.length, c.toString('utf8'), Array.from(c).join(',')]));
req.end();
"
```
Outputs `[ [ 12, '...', '0,0,0,0,0,0,0,0,0,0,0,0' ] ]` — length right,
content wrong.

**Critical question we did NOT answer:**

Our `crypto-sha256.js` test does:
```js
c.createHash('sha256').update('hello').digest('hex')
```
and produces the CORRECT sha256 of "hello".  But sha256 internally must
encode the string to bytes — which means `Buffer.from(str)` or equivalent
must work there.  So why does it work in crypto but not in the fetch
tunnel?

Possibilities:
- Context/realm dependent — fetch-tunnel runs from a microtask context;
  crypto.update runs synchronously.  Maybe Buffer encoding diverges by
  realm.
- Policy interaction — `outbound-fetch-tunnel` policy is active in the
  failing case; `buffer-pool-disable` is in both.  Maybe the prelude
  monkey-patches break Buffer's internal encoder.
- Object-vs-string handoff — when user calls `req.write('payload')`,
  Writable internals might decode the string to a Buffer-via-wasm-pool
  view that immediately gets overwritten.
- Maybe `Buffer.from(string)` actually works fine, and the
  ZERO-ization happens later via Buffer.concat or Writable buffering.

**Investigation steps:**

1. **Direct test in clean context.**  Doesn't touch fetch or http:
   ```bash
   node --experimental-wasm-exnref --import ./node_modules/tsx/dist/loader.mjs \
     scripts/node-harness.mjs --quiet --policies buffer-pool-disable -e "
   const b = Buffer.from('hello', 'utf8');
   console.log('len:', b.length, 'bytes:', Array.from(b).join(','));
   "
   ```
   If this produces zeros, the bug is in `Buffer.from(string)` itself.
   If correct, the bug is downstream (Writable / our _write capture).

2. **With outbound-fetch-tunnel applied but no http use:**
   ```bash
   node ... --policies buffer-pool-disable,outbound-fetch-tunnel -e "
   const b = Buffer.from('hello', 'utf8');
   console.log(b.length, Array.from(b));
   "
   ```
   If still wrong, the fetch-tunnel prelude is corrupting Buffer somehow.

3. **Inside Writable._write, what does chunk look like?**  Add
   diagnostic in `outbound-fetch-tunnel.ts` `_write` to log
   `[chunk.length, chunk[0], chunk[1], ...]` immediately on entry.

4. **Where does crypto encode strings?**  Read `lib/internal/crypto/hash.js`
   to see how `update(str)` converts to bytes.  Likely a different path
   than user-visible Buffer.from.

**Files to read first:**
- `browser-target/src/napi-host/index.ts` — `patchEmnapiToUseWasmBackedBuffers`
  is the obvious suspect.
- `lib/buffer.js` — edge's Buffer impl, especially `Buffer.from`,
  `FastBuffer`, `fromString`.
- `lib/internal/buffer.js` — `utf8Write` and friends.

**Why this is scariest:** silent data corruption.  Anything that does
`Buffer.from(string)` in a context-sensitive way might be writing zeros
without us noticing.  Could be lurking under our HTTP tests if the
strings happen to be empty or test assertions only check length.

---

## Recommended investigation order

If you have time for ONE thing, do **#4 (buffer-from-string-zeroed)**.
The risk of silent corruption beats everything else.

If you have time for two: **#4 then #1 (SAB/AB)** — both are
wasm-memory-data-flow bugs that probably share root cause infrastructure
(our napi_create_buffer overrides) even if symptoms differ.

If you have time for all four: **#4 → #1 → #2 → #3.**  The async-pattern
bugs (#2, #3) are probably layered on top of correct buffer/memory
handling; root-causing them first leads to whack-a-mole.

When fixing each, prefer the real-napi-layer fix (per your stated
preference) over JS-layer polyfill.  The workaround in the fetch-tunnel
prelude (silent console.log pre-init) is acceptable as a temporary
patch but ugly to leave permanent.

---

## Pause Inventory

### Half-done in this session

**`outbound-fetch-tunnel` policy — code ships, test skipped**
- `browser-target/src/policies/outbound-fetch-tunnel.ts` — correctly
  designed Policy.  Test at `tests/js/policy-outbound-fetch-tunnel.js`
  is `.skip`'d with reasons.  Unblocks when #4 or #1 lands.

**ESM investigation never started**
- Per your instructions: "when finish consult me on ESM support, but
  only after you investigate how we did it in the xnitro package in
  ../localwin".  You stopped before I got to it.  When you resume:
  1. Investigate `../localwin/xnitro` (or wherever xnitro lives) to
     see the ESM approach used there.
  2. Report back to YOU, do not start implementing.
  3. Decision on whether to apply same approach to edge.js is yours.

**Test runner has no timeout flag**
- The runner has a hardcoded 30s timeout per test.  Some skipped tests
  (`webserver.js`) would benefit from a per-test override mechanism.

### Big chunks never started

In priority order (from before the pause):

| Chunk | Scope | Why it matters |
|---|---|---|
| **ESM support** (`module_wrap_*`) | 600-1500 LOC, likely needs Asyncify | Most modern code uses `import`; 18 `module_wrap_*` stubs return placeholders.  YOU asked to investigate xnitro first. |
| **OPFS persistence** | ~200-400 LOC + async pre-warm | You said "save for last".  Needed for any stateful app surviving page reload. |
| **worker_threads** | ~300-500 LOC | Each worker = real Web Worker over SAB; niche but unavoidable for some workloads. |
| **Memory hygiene** | ~100-200 LOC | `_malloc`'d buffers never `_free`'d → long-running OOM.  Also: wire `__indirect_function_table` so emnapi finalizers stop silently no-op'ing. |
| **`outbound-via-relay` policy** | ~200-400 LOC + relay infra | "Real" path for outbound (vs polyfill); needs hosted relay. |
| **child_process** | Unknown, large | Browser-incompatible by design. |

### Smaller debts

52+ `#!~debt` markers across `browser-target/`.  Sample of biggest categories:

- **Sockets**: `single-listener`, `single-flight`, `no-keep-alive`,
  `no-chunked-encoding`, `no-outbound`, `no-socketpair`, `no-sendfile`,
  `wake-slot-collisions`, `fake-local-addr`, `fake-peer`, `no-ipv6`
- **FS**: `naïve-stat-via-fetch`, `no-write-support`, `no-readdir`,
  `sync-xhr-network-blocking`
- **napi/unofficial**: many no-op stubs that need promotion when a
  workload lights them up
- **Boot**: `crude-circuit-breaker`, `fake-fs-fallback`,
  `dynCall-before-table-ready`
- **The 4 new ones from this session**: `sab-ab-body-read`,
  `lazy-load-from-microtask`, `microtasks-starved-by-pending-timer`,
  `buffer-from-string-zeroed`

Fix each when a real workload lights it up, not preemptively.  The
exception is `#4 buffer-from-string-zeroed` which is silent corruption
and should be hunted down even without a specific workload demanding it.

---

## Architecture re-orientation

(If you're rusty when you come back, this is the 60-second re-onboard.)

**Two iteration loops:**
- **Node harness** (`browser-target/scripts/node-harness.mjs`) — ~3s
  startup, same code paths as the browser except `fs.readFileSync`
  instead of sync XHR.  Used for fast iteration on napi/wasi/crypto.
- **Browser** (`vite dev` on `:5180`) — ~15s, full end-to-end including
  Service Worker bridge.  Used to verify SW-mediated behaviors.

**Test runner:**
```bash
node browser-target/scripts/test-runner.mjs
```
Iterates `tests/js/*.js`, runs each through the harness with `--quiet`,
compares captured stdout/stderr to sibling `*.stdout` / `*.stderr` files.
`*.skip` files mark skips; `*.harness-args` files add per-test flags
(e.g. `--policies a,b,c`).

**Wasm host shape:**
```
edgejs.wasm  imports →
  wasi_snapshot_preview1, wasix_32v1, wasi  (browser-target/src/wasi-shim.ts)
  napi, env                                  (browser-target/src/napi-host/)
  emnapi                                     (@emnapi/core)
```

**Policies framework** (NEW this session — the DI layer for deployment-
varying behaviors): `browser-target/src/policies/index.ts`.  See the
header comment there for the philosophy.  Default browser stack is
Node-honest (throw on unsupported); shortcuts are explicit opt-ins.

**Where to start reading when investigating any bug:**
- `browser-target/src/wasi-shim.ts` — every WASI syscall, the entire
  socket virtualization, poll_oneoff, fs adapter routing
- `browser-target/src/napi-host/index.ts` — emnapi composition, the
  wasm-backed-buffer patches, the napi_run_script override
- `browser-target/src/napi-host/unofficial.ts` — the 80 unofficial_napi_*
  functions, including the compile_function hook
- `lib/buffer.js` — edge's Buffer impl (vendored Node source)
- `src/edge_module_loader.cc` — edge's C++ side that calls our wasm
  imports.  Not in our repo to modify casually but useful to read.

**The data-flow that matters:**
- Wasm asks for a Buffer → `napi_create_buffer` (overridden) → `_malloc`
  in wasm, returns wasm-backed view via emnapi external-array hook
- Wasm calls JS via `napi_call_function` → emnapi marshalls → handler
  in our host
- Edge's bootstrap modules compiled via
  `unofficial_napi_contextify_compile_function` (we override for module
  source replacement)
- Lazy builtins compiled via `napi_run_script` (we wrap to also do
  module override)

---

## Your stated rules

(Important context for any decision when resuming.)

From `~/.claude/projects/.../memory/` — keep applying:

1. **Full Node compat first** — fix the real napi/wasi layer until edge's
   own implementation works; polyfilling at the JS layer is a fallback,
   not a preferred path.  Especially relevant when investigating the 4
   bugs above — prefer the deep fix even if a JS polyfill would patch
   the symptom.

2. **Vendored deps behind facades** — third-party libs (emnapi, libuv,
   etc.) sit behind project-owned interfaces, imported in exactly one
   adapter file, so they're swappable.

3. **Every shortcut gets BOTH a `#!~debt` inline comment AND a NOTES.md
   catalog entry.**  The 4 new debts in this session follow this rule.

4. **No upstream issue filing** — don't suggest opening issues against
   upstreams (edge.js, emnapi); log deviations in `NOTES.md` instead.

5. **Finish tight and clean** — no task is "done" until typecheck is
   green, dead code is gone, comments match current state, `#!~debt`
   is in sync, and verification ran for real.

6. **Policies DI pattern** — deployment-varying behaviors go through
   `browser-target/src/policies/*.ts`, default is Node-honest, shortcuts
   are opt-in.  When adding ANY behavior that might vary, ask "is this
   a policy?" before hardcoding.

7. **About ESM specifically:** you asked me to investigate `xnitro` in
   `../localwin` BEFORE consulting on edge.js ESM strategy.  Do this
   investigation, then bring findings to YOU for the call.

---

## Investigation toolkit

Useful commands when you come back.

**Run the full test suite:**
```bash
node browser-target/scripts/test-runner.mjs
```

**Run a single test via the harness:**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --quiet --policies buffer-pool-disable \
  -e "$(cat ../tests/js/log.js)"
```

**Verbose harness run (see [harness] diagnostic lines):**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  -e "..."   # no --quiet
```

**Add a temporary `[compile-debug]` log to see what's being compiled:**
Edit `browser-target/src/napi-host/unofficial.ts`, find
`unofficial_napi_contextify_compile_function`, add at the top:
```ts
ctx.postLog?.(`[compile-debug] ${JSON.stringify(filename)} codeLen=${code.length}`, "debug");
```
Then run without `--quiet` to see the lines.

**Trace tail (last N napi calls before exit):**
Add to `node-harness.mjs` after `_start`:
```js
const tail = trace.tail(50);
for (const r of tail) errlog(`  ${r.t.toFixed(0)}ms ${r.ns}.${r.sym}(...) → ${r.ret}`);
```

**Find all `#!~debt` markers:**
```bash
grep -rn '#!~debt' browser-target/src/ | wc -l   # count
grep -rn '#!~debt' browser-target/src/           # full list
```

**Typecheck:**
```bash
cd browser-target && npx tsc --noEmit
```

**Where the wasm comes from:** `browser-target/edgejs.wasm` — symlink to
the build artifact at `napi/target/.../edgejs.wasm` (gitignored).
Rebuild via the upstream edge build system if you change the wasm-side
contract.

---

*Snapshot taken 2026-05-21 at commit `c369dc61`.  When you resume,
`git log c369dc61..HEAD` will show what's happened since.*


---

## Microtask drain investigation — 2026-05-22

After Phase B (rebuilt edge.js with proper `unofficial_napi_*` wasm imports)
shipped, two skipped regression tests remained:
- `regression-lazy-load-from-microtask.js` — `console.log('a','b')` inside
  a `Promise.then` produces no output (lazy-load returns non-function)
- `regression-microtask-not-starved.js` — pending `setTimeout` blocks
  `Promise.then` resolution past the timer fire

We investigated whether the deeper fix could land via JS-side patches alone.
Spun up an isolated subagent experiment in `/tmp/microtask-drain-experiment/`
to test escape hatches outside of edge.js's wasm.

**Finding**: edge.js's main loop (`src/edge_runtime.cc:1870`) calls
`unofficial_napi_process_microtasks(env)` once per iteration expecting
`Isolate::PerformMicrotaskCheckpoint()`.  V8's PerformCheckpoint early-returns
when `MicrotasksScope::GetMicrotasksScopeDepth() > 0`.  In an isolated test
(`exp8-harness-fix-pattern.mjs`), calling `instance.exports._start()` from a
fresh `setImmediate` callback opens scope depth 0, and `process._tickCallback()`
from inside a host import DOES drain promises queued mid-wasm.

**But this doesn't translate to edge.js's full runtime.** Inside `_start`,
edge runs its own libuv loop.  Timer / I/O callbacks fire INSIDE Node's
outer InternalCallbackScope, not under their own fresh MicrotasksScope.
Scope depth stays >= 1 throughout `_start`.  So even with the harness
wrap + `_tickCallback` plumbed through, intra-loop drain doesn't happen.
End-of-`_start` drain does — but by then the bug reproducer's timer
callback has already run with stale state.

**Prior hypothesis (wrong)**: emnapi creates a separate V8 Context per env,
so Node's `_tickCallback` drains the wrong queue.  Untrue — emnapi's "Context"
is a pure JS class, no `v8::Context`; queues are shared.

**Real fix paths** (in NOTES.md item #1):
1. Asyncify-at-the-syscall-boundary — wasm yields to event loop on
   timer-only `poll_oneoff`, scope closes, drain runs, resume.
2. C++ patch in edge.js to wrap napi_call_function in
   `MicrotasksScope(kRunMicrotasks)` so each user-callback returns
   trigger a drain.
3. Full Asyncify on `_start`.
4. Move wasm to worker_threads + main-thread microtask pump (architectural).

**State as of this entry**:
- `unofficial_napi_process_microtasks` calls `process._tickCallback` via
  the `__edgeHostTickCallback` snapshot in `host/globals-shim.ts`.  This
  is "correct intent": it composes properly once any of the above fixes
  land.  Today it only drains at end-of-`_start`.
- Harness left as direct `instance.exports._start()` call (the
  setImmediate wrap doesn't help our deep loop and only complicates
  reading the entry point).
- Two regression tests stay `.skip` until rebuild lands.

Files left from the investigation (delete when no longer interesting):
`/tmp/microtask-drain-experiment/{tiny.wat,tiny.wasm,exp1..exp9*.mjs,.cjs}`.
