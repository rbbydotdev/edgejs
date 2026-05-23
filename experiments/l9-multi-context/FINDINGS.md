# Q8: emnapi multi-context isolation — findings

**Date:** 2026-05-23
**Result:** PASSES — N independent contexts work on a single JS thread.

## Test (probe.mjs)

Created 3 emnapi v2 contexts (A, B, C) on the same thread:

```
[ctxA] handles: napi_get_undefined=2, napi_get_null=3, napi_get_global=6
[ctxB] handles: napi_get_undefined=2, napi_get_null=3, napi_get_global=6
[ctxC] handles: napi_get_undefined=2, napi_get_null=3, napi_get_global=6

[main] refStore identity check:
  ctxA.refStore === ctxB.refStore: false
  ctxA.refStore === ctxC.refStore: false
[main] ctxA.isolate === ctxB.isolate: false
```

Each context has its own `refStore` Map and `isolate` object — same
class instances, distinct identities.  Handle IDs OVERLAP across
contexts (each starts at the same base), but they refer to different
JS values in each context.

## Implication for L9 worker_threads

For each user `new Worker(...)`:
1. Allocate a new emnapi context on host: `createContext()`.
2. Allocate a new napi module: `createNapiModule({ context, childThread: false, ... })`.
3. Each Worker's wasm RPCs route to its OWN context (via hostWorkerId
   demux already wired in L1's sab-ring + L9 multi-host spike).

Handle IDs are per-context.  A handle id 42 in Worker A refers to a
different value than handle id 42 in Worker B.  Wasm-side must use the
right RPC route based on which user-Worker it belongs to.

The `contextId` field in our sab-ring slot header (added in L1) is
the natural way to disambiguate.

## No surprises

- Contexts are independent JS object graphs (refStore, isolate, etc.)
- No shared static state between contexts
- Creating multiple contexts is cheap (microseconds; 3 contexts created
  in this probe in <10ms total)

## L9 design implications

- One host worker can hold N user-Worker contexts (cheap to multiplex)
- OR one host worker per user-Worker (more isolation, more workers)
- The L9 multi-host spike already validated multi-host-worker topology;
  this validates the alternative single-host-multi-context topology
- Either works.  Pick based on performance (host CPU bound? more workers
  helps) or isolation requirements (cross-worker isolation harder than
  same-worker contexts).

## Conclusion

L9 has TWO viable topologies for worker_threads, both architecturally
validated:

1. **Per-Worker host+wasm pair** (L9 spike showed routing works)
2. **Shared host worker with per-Worker context** (this probe showed
   contexts are isolated)

Initial L9 implementation can use whichever is simpler given the
scheduling shape.  Per-Worker host+wasm pair was the "research
recommended" approach; this Q8 finding adds the option of sharing the
host worker (which is cheaper in resources).
