# Q1: malloc re-entrancy deadlock — findings

**Date:** 2026-05-23
**Result:** RESOLVED via Solution A (pre-allocated pool, host-side bookkeeping)

## Reproduction (probe-reproduce.mjs)

Confirmed the deadlock exists exactly as described in
`experiments/l5-emnapi-v2/FINDINGS.md`:

```
[main] received worker's napi request — now needs malloc from worker
[main] waiting for malloc reply from worker (will deadlock)...
[main] Atomics.wait for malloc reply returned: timed-out
[main] DEADLOCK CONFIRMED — main timed out waiting for malloc reply
```

When the host needs to call wasm's `malloc` export while the wasm
worker is blocked in `Atomics.wait` for the host's napi reply, both
sides wait forever.  Timeouts mask it; without them, the process
hangs.

## Resolution (probe-pool.mjs)

Pre-allocate a region in wasm linear memory at boot.  Host maintains
the allocator state JS-side.  emnapi's `exports.malloc` proxy on host
hits the JS allocator directly — no RPC to wasm.

```
[main] received worker's napi request — needs malloc
[main] pool-allocated 4096 bytes at ptr=1024
[main] wrote 8 bytes of 0xAA at the allocated region
[main] worker verified the pool-allocated region
[main] DEADLOCK RESOLVED via pool — pool now at offset 5120
```

The worker received its napi reply, verified the bytes host wrote
into the shared memory at the allocated address.  No deadlock; no
extra RPC.

## Why this is correct

Three structural reasons it works:

1. **Wasm linear memory is shared.** Host has direct read/write access
   to the same bytes wasm sees.  No serialization for the data.

2. **malloc is a JS-level concept, not a wasm concept.** "Allocating"
   just means picking an address from a free list and reserving it.
   The bookkeeping doesn't HAVE to live in wasm — it's just a Map of
   `{ptr: size}` and a free-list head.

3. **Emnapi's malloc usage doesn't need re-entrant wasm calls.** Every
   call site is "give me N bytes" then "use the ptr to access them."
   The ptr just needs to be valid (in-bounds, aligned, exclusive).
   Whether wasm or JS hands it out is invisible to the caller.

## Implementation guidance for L5

Concrete plan for the production version:

### Boot-time setup

```c
// edge.js's wasm side, called early during _start
__attribute__((visibility("default")))
size_t emnapi_get_host_pool_base() {
  static char POOL[16 * 1024 * 1024];  // 16 MB reserved region
  return (size_t)&POOL[0];
}

__attribute__((visibility("default")))
size_t emnapi_get_host_pool_size() {
  return 16 * 1024 * 1024;
}
```

### Host-side allocator

```js
// On host worker, when emnapi initializes:
const poolBase = await rpc.call(OP_GET_POOL_BASE);
const poolSize = await rpc.call(OP_GET_POOL_SIZE);
const allocator = new HostPoolAllocator(poolBase, poolSize);

// Override the proxy malloc/free on the stub instance:
stubInstance.exports.malloc = (size) => allocator.malloc(size);
stubInstance.exports.free = (ptr) => allocator.free(ptr);
```

### Allocator implementation choices

| Allocator | Pros | Cons |
|---|---|---|
| Bump-only (no free) | trivial; <30 LOC | exhausts over time; not viable long-term |
| Bump + reset-per-script | simple; good for short scripts | breaks long-running servers |
| Free-list (first-fit) | real malloc semantics; ~150 LOC | fragmentation |
| Free-list + coalesce | best fit; ~250 LOC | more bookkeeping |
| Slab allocator | fast for fixed sizes; ~300 LOC | overkill |

**Recommendation for L5 F-1:** start with bump-only.  Most napi calls
that malloc are short-lived (TSFN structs, async work) and the test
suite finishes before pool exhausts.  Validate; iterate.

Upgrade to free-list when the first real workload exhausts the pool
(Astro should hit this — bundling thousands of files allocates a lot).

## Other resolutions considered

### Solution B: wasm-side interruptible wait

Wasm worker periodically polls a "malloc request slot" while in
Atomics.wait by using a timeout-based wait.  When it sees a request,
services it, then resumes waiting.

- ✓ Real wasm malloc semantics
- ✗ Adds latency to every napi call (polling)
- ✗ Complex re-entrancy logic
- Not worth it given A works.

### Solution C: dedicated memory worker (3rd worker)

A third worker handles malloc requests; doesn't deadlock because
it's not the runtime worker.

- ✗ Needs synchronization on the pool state across workers
- ✗ Doesn't simplify anything vs A (host-side allocator)
- ✗ More workers, more setup
- A is strictly better.

### Solution D: reverse the dependency

Wasm pre-allocates the buffer before calling napi, passes the ptr in
the request.  napi just records the ptr.

- ✓ No host-side allocator needed
- ✗ Requires changes to emnapi internals (each malloc-needing op
  rewritten to take a pre-allocated ptr)
- ✗ Not a clean substitution for `_malloc`
- Possible but invasive.

### Solution E: hybrid A + B fallback

Use pool by default; if pool exhausted, fall back to interruptible
wait for B's real malloc.

- ✓ Resilient
- ✗ Implements both paths
- Worth considering once we see real exhaustion patterns.

## Resolution: ship A (bump-only), upgrade to free-list as needed

This unblocks L5 F-1.  The deadlock is no longer an architectural
risk — it's a sizing concern (pool size).  Concrete + measurable.
