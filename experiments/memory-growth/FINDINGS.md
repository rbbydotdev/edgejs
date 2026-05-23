# Q4: shared memory growth — findings

**Date:** 2026-05-23
**Result:** RESOLVED — no protocol needed; emnapi v2 already handles it correctly.

## Behaviour observed (probe.mjs)

When wasm worker calls `memory.grow(1)` on a shared `WebAssembly.Memory`:

| Aspect | Result |
|---|---|
| Old views still work for OLD region | ✅ `view0[0]` still reads 0xAA |
| Old views have STALE `.byteLength` | ✅ stays at 65536; doesn't grow |
| Old views can't read NEW region | ❌ `view0[65536]` returns `undefined` |
| Old views silently drop writes to new region | ❌ write to `v[65536]` is no-op |
| `memory.buffer` gives a NEW ArrayBuffer after grow | ✅ `byteLength` is 131072 |
| Fresh `new Uint8Array(memory.buffer)` sees full size | ✅ 131072 bytes accessible |
| Cross-worker writes survive grow | ✅ data preserved |

## Implication for L5

emnapi v2's existing pattern is **always create a fresh view per use**:

```js
// From vendor/emnapi/packages/emnapi/src/string.ts:135
const HEAPU8 = new Uint8Array(wasmMemory.buffer)
```

`wasmMemory.buffer` accesses the CURRENT backing buffer (post-grow if applicable).
Creating a fresh `Uint8Array` on it always sees the current size.

emnapi's napi functions already follow this pattern in every call site
I inspected (memory.ts, string.ts, wrap.ts).  So when wasm grows the
memory, the NEXT napi call sees the new region automatically.

## What this means for the L5 implementation

**No re-view-after-grow protocol needed.**  Our host-side RPC server
code just needs to follow the same discipline:

✅ DO: `new Uint8Array(memory.buffer)` inside each handler
✅ DO: pass the `WebAssembly.Memory` object (not its buffer) to emnapi
❌ DON'T: cache `memory.buffer` or its views in long-lived state

For the host-side allocator (Q1 resolution), we'd similarly want to
re-view per allocation if the pool spans past the original size.  But
since the pool is allocated AT BOOT inside the initial pages, that's
not an issue today.

If we later want a growable pool: re-view on each malloc.

## Cross-worker semantics confirmed

The shared memory model just works.  Writes by one worker are
immediately visible to others (modulo memory ordering, which Atomics
handles).  The grow operation doesn't require notification — workers
just need to be aware that fresh views see more.

## No code change needed

Q4 RESOLVED.  Move on to next question.
