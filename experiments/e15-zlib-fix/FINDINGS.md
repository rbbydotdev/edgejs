# E15: zlib bundled-async crash fix — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a2038df0dbcbdf93b` (port 5190)
**Result:** **Fixed.**  New policy `zlib-writestate-wasm` shipped in
`defaultBrowserPolicies` + `minimalPolicies`.  Closes the
`zlib-have-should-not-go-down` debt from E13.  Suite: 31/0/3 → 32/0/3.

## Approach chosen

E13 recommended Option 2 (napi-level override of
`napi_create_typedarray`).  The agent investigated and found this
**infeasible**: JS code holds a direct reference to the JS-heap
`Uint32Array`, and we cannot mutate a typed array's underlying
buffer.  Replacing the emnapi handle-store entry would update C++'s
view but not JS's `this._writeState` reference.  So we'd have a
twin in wasm memory that C++ reads but JS still reads stale data
from its original.

Fell back to **Option 1**: a `{post}` policy patch on `lib/zlib.js`
that swaps the `Uint32Array(2)` for a wasm-backed twin BEFORE the
binding's `init()` captures it as `_writeState`.

## Implementation

New file `browser-target/src/policies/zlib-writestate-wasm.ts`.
Wraps `binding.{Zlib,BrotliEncoder,BrotliDecoder,ZstdCompress,
ZstdDecompress}.prototype.init` to swap the `Uint32Array(2)`
argument with a wasm-backed twin allocated via
`internalBinding('buffer').createUnsafeArrayBuffer(8)`.

The twin is stashed on the handle as `__edgeWasmWriteState`.  The
LOCAL `Zlib` and `Brotli` function declarations are reassigned so
all subclasses (Gzip, Gunzip, Deflate, Inflate, DeflateRaw,
InflateRaw, Unzip, BrotliCompress, BrotliDecompress) pick up the
twin into `this._writeState`.  Zstd needed `module.exports` wrapping
via `Reflect.construct` because class-extends captures the parent
at decl time.

## Test

New test `tests/js/zlib-bundled-gzip.{js,stdout}` exercises
`zlib.gzip('hello world', cb)` without the
`compression-via-compressionstream` policy.  Used to crash with
`ERR_INTERNAL_ASSERTION: have should not go down`; now passes.

## Suite result

**32 pass, 0 fail, 0 err, 3 skip** (was 31/0/3).
Skips unchanged: fs-readfile-self, override-inspector, webserver.
`tsc -b` clean.

## Why this lands in DEFAULTS, not opt-in

The bug affects ANY caller using `zlib.gzip` / similar without
`compression-via-compressionstream` — i.e., the Node-honest sync
path.  Without the fix, calling `zlib.gzip` on the default config
crashes hard.  Adding to `defaultBrowserPolicies` AND
`minimalPolicies` is the right move: this is a CORRECTNESS fix,
not a performance opt-in.

`compression-via-compressionstream` (E11) is now perf-only opt-in
(it routes through native CompressionStream for potentially faster
gzip, but the bundled path now works correctly too).

## Open questions

1. **Generality** — fix is specific to zlib's three `_writeState`
   slots.  Other bindings passing small JS-heap typed arrays to
   C++ persistent refs would have the same staleness bug.
   Audit `lib/` for similar patterns.  Candidates:
   `_writeState`-like usage in `dgram`, `tls`, `http2`,
   `internal/url`.  Each is its own potential debt.
2. **A general napi-layer fix** would be more robust but a larger
   surface — would need to detect "this typed array will be retained
   by C++ and modified" at create-time, which is hard to do
   reliably.  Deferred.
3. **Transform-stream paths** (`createGzip()` writeable stream) —
   share `processCallback` so should work, but no separate
   regression test yet.  Add later.

## Files changed in main

- `browser-target/src/policies/zlib-writestate-wasm.ts` (new)
- `browser-target/src/policies/index.ts` (export + import +
  minimalPolicies + defaultBrowserPolicies + policyRegistry)
- `tests/js/zlib-bundled-gzip.{js,stdout}` (new test)
