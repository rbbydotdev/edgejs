# E13: bundled wasm zlib crash debug — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a8d8f11551131b19c` (port 5188)
**Result:** **Root cause identified by code analysis.  Fix NOT
implemented.**  Recommended a medium-effort fix; deferred to a
separate experiment.  Also surfaced an unrelated node-harness
regression that's tracked separately.

## The bug

`zlib.gzip('hello world')` on the wasm browser target crashes with:
```
Error [ERR_INTERNAL_ASSERTION]: have should not go down
  at Zlib.processCallback (lib/zlib.js:531)
```

The `compression-via-compressionstream` policy (E11) bypasses this
crash by routing through host-native CompressionStream entirely.
Without the policy, bundled wasm async zlib is broken.

## What `have` is

In `lib/zlib.js:531` (async path, `processCallback`):
- `have = handle.availOutBefore - availOutAfter`
- `handle.availOutBefore` is set by JS to `self._chunkSize -
  self._outOffset` (typically 16384) BEFORE queuing C++ async work.
- `availOutAfter = state[0]` where
  `state = self._writeState = new Uint32Array(2)` (line 674).
- C++ writes `write_result[0] = strm_.avail_out` in
  `UpdateWriteResult` (`src/internal_binding/binding_zlib.cc:1188`).

`have < 0` means `strm_.avail_out` somehow grew, which is
structurally impossible.  So `state[0]` must NOT actually reflect
what C++ wrote.

## Root cause: `_writeState` is JS-heap, never wasm-aliased

`buffer-wasm-aliased` patches `createUnsafeBuffer` in
`internal/buffer.js` so `Buffer.allocUnsafe(N)` becomes wasm-backed.
But `new Uint32Array(2)` doesn't go through that path — it's a
regular JS-heap typed array.

The flow for a JS-heap typed array (per emnapi's `getViewPointer`
in `node_modules/@emnapi/core/dist/emnapi-core.cjs.js:2306-2387`):

1. First `napi_get_typedarray_info` call (during `handle.init` →
   `ExtractUint32ArrayData`, binding_zlib.cc:1446): host override
   (`browser-target/src/napi-host/index.ts:395`) runs
   `syncWasmToJs(ta)` — but the address isn't cached yet, so
   `getViewPointer(v, false)` returns `{address: 0}` → `syncMemory`
   throws "Unknown ArrayBuffer address" → override silently catches.
   emnapi original then mallocs an 8-byte wasm region, copies
   JS→wasm `[0,0]`, caches with `ownership:0, runtimeAllocated:1`
   (Node has FinalizationRegistry).
2. Every subsequent `UpdateWriteResult` → `GetWriteResultData` →
   `napi_get_typedarray_info`:
   - Override `syncWasmToJs` runs FIRST, copying wasm→JS the
     PREVIOUS completion's values.
   - emnapi original re-copies JS→wasm (round-trip, lossless
     because of step a).
   - Returns the cached pointer.
   - C++ then writes the NEW `[avail_out, avail_in]` to wasm.
3. `InvokeProcessCallback` → JS callback reads `state[0]` from
   JS-heap, which still holds the PREVIOUS completion's values.

**Net effect: JS sees `state` one completion behind wasm.**
`_writeState` is the only relevant view that DOESN'T flow through
the aliased path, so the bug lands there.

That `compression-via-compressionstream` avoids the bug confirms
the root cause: that policy bypasses `_writeState` entirely.

## Why specifically `have < 0`

Stale-by-one alone explains wrong-data results but not the literal
negative `have` on the first call (initial `[0,0]` → `have = 16384
- 0 = 16384`, positive).  The crash likely surfaces on the second
or third inner-write iteration: after `availOutAfter===0` triggers
a chunk reset (`handle.availOutBefore = 16384`), the next DoWork
on empty input returns `Z_BUF_ERROR`/`Z_STREAM_END` with
`avail_out=16384` unchanged, but the stale-read in the NEXT
callback shows a leftover `state[0]` value that mismatches the new
`availOutBefore`.  Exact sequence needs a working node-harness to
confirm.

## Fix recommendation — MEDIUM (3 options)

1. **Patch `lib/zlib.js:674`** via a policy `{ post }` override to
   make `_writeState` wasm-backed (e.g. allocate from the same
   wasm pool as `_outBuffer`).  Cleanest semantically; one
   targeted patch.
2. **Override `napi_create_typedarray`** (or hook `handle.init`) to
   swap the 2-element write_result Uint32Array for a wasm-backed
   view.  Minimum surface; doesn't touch `lib/`.
3. **Fix the sync direction**: add a "before-JS-callback"
   wasm→JS sync hook in `EdgeAsyncWrapMakeCallback`, or expose a
   new `napi_sync_typedarray` for C++ to call after
   `UpdateWriteResult`.  Most invasive; adds a new sync surface.

**Did NOT implement.**  Without a working node-harness, the agent
couldn't verify a fix actually closes the crash.  The exact
sequence producing `have < 0` (vs. just wrong-data) is unconfirmed.

## Status today

The compression-via-compressionstream policy (E11) is shipped and
works as a complete workaround for any caller that opts in.  The
bundled zlib bug only affects callers who do NOT enable that
policy.  Since the policy is the documented recommended path, the
bundled-zlib crash is bounded in real impact.

## Open questions

1. Exact `state[0]`/`state[1]` values at the moment `have < 0`
   fires — needs working node-harness + a one-line debug print.
2. Whether option 2 is the right shape, or whether "JS-heap
   typed arrays shared with C++ must be wasm-aliased" deserves a
   general policy.
3. Does the same root cause affect other bindings that use ad-hoc
   small Uint32Arrays for state?  Audit: search for
   `_writeState`, `_inBuffer`, etc. patterns.

## Key file references

- `lib/zlib.js:524-531` — failing assertion
- `lib/zlib.js:670-682` — `_writeState` allocation & `handle.init`
- `src/internal_binding/binding_zlib.cc:1182-1190` — `UpdateWriteResult`
- `src/internal_binding/binding_zlib.cc:1444-1450` — `_writeState`
  captured at init
- `browser-target/src/napi-host/index.ts:394-399` —
  `napi_get_typedarray_info` override (wrong sync direction)
- `browser-target/src/policies/buffer-wasm-aliased.ts` — patches
  `createUnsafeBuffer` only
- `browser-target/node_modules/@emnapi/core/dist/emnapi-core.cjs.js:2306-2387`
  — `getArrayBufferPointer`/`getViewPointer` round-trip caching
