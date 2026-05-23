# Callback dispatch — API spec for per-op agents

This is the consumer-facing spec for `callback-dispatch.ts`.  Per-op
agents (the 13 remaining callback-bound napi ops in Lever B batch 4)
**only** need this document — they should not have to read the 200 LOC
of dispatcher implementation.

Pairs with `callback-triage.ts` for the future in-process tier (today
empty by design; see that module's header for policy).

## Public API

### Host-side: build a JS closure that round-trips to wasm

```ts
import { makeHostSideCallbackClosure } from "./callback-dispatch";
import type { SyncRpcClient } from "./rpc-client-sync";

const closure = makeHostSideCallbackClosure({
  reverseClient,   // SyncRpcClient over the REVERSE rings (host → wasm)
  cbPtr,           // funcref index (3rd arg to napi_create_function)
  dataPtr,         // opaque data (4th arg to napi_create_function)
  env,             // napi_env handle
  hostWorkerId,    // optional; default 0 (single host worker today)
  contextId,       // optional; default 0
});

// `closure(...args)` blocks via Atomics.wait on the reverse channel,
// returns the wasm callback's napi_value return.  Throws if the wasm
// callback threw.
```

Returned function signature: `(...args: unknown[]) => unknown`.

Args are expected to be **napi_value handles (u32)**.  In practice
emnapi passes them through directly from `napiValueFromJsValue` so
the caller never has to materialize them — emnapi's `withScope`
wrapper handles handle lifetime.

### Wasm-side: register the reverse-RPC invoker

```ts
import {
  registerWasmCallbackInvoker,
  createCallbackDepthCounter,
} from "./callback-dispatch";

const depthCounter = createCallbackDepthCounter();
registerWasmCallbackInvoker(reverseRpcServer, {
  wasmTable: instance.exports.__indirect_function_table as WebAssembly.Table,
  depthCounter,
  // maxDepth: 32  // default; override only for tests
});
```

Call this in `worker.ts` exactly once per runtime worker, after the
wasm instance is bound (so `__indirect_function_table` is populated)
and after the reverse-RPC server is constructed.

## Exception marshalling format

Reverse-reply payload layout (in-band, NOT the RPC-transport status):

```
[u32 status]         0 = ok, nonzero = wasm callback threw
[u32 returnHandle]   napi_value when status==0; ignored otherwise
[N bytes utf8]       error message when status != 0
```

Mirrors the existing `REPLY_STATUS_HOST_ERROR` convention in
`rpc-server.ts:111-129` (write UTF-8 error bytes as the payload, status
field signals failure).  We layer two statuses:

  * **RPC-transport status** (`reply.status`) — non-OK means the wasm
    worker's reverse-RPC server itself failed to deliver the call
    (e.g. ring full, handler not registered).  Host throws.
  * **In-band callback status** (first u32 of payload) — wasm callback
    ran and threw.  Host throws.

Both surfaces produce the same observable: a synchronous `throw new
Error(msg)` from the closure returned by `makeHostSideCallbackClosure`.

## Re-entrancy depth bound: 32

`registerWasmCallbackInvoker` enforces `depthCounter.depth < 32` before
invoking the funcref.  Beyond that, the handler returns an in-band
error ("callback re-entrancy depth exceeded") which the host surfaces
as a thrown `Error`.

R6a (`experiments/r6-nested-sync-rpc/FINDINGS.md`) tested the
re-entrant wait loop cleanly to depth 16 in Node 24's JSPI runtime.
32 is the production safety cap — twice the empirically clean ceiling,
well below the 32-slot ring width that would mechanically cap things.

## Triage policy

Per-op handlers MUST NOT pre-filter callbacks against
`HOT_PATH_CALLBACK_IDENTIFIERS` at op-creation time.  Every callback
goes via the dispatcher — the in-process funcref tier is a future
optimization gated on actual perf measurements (see
`callback-triage.ts` policy block).

Concretely: `napi_create_function` should call
`makeHostSideCallbackClosure` and store the returned function as the
napi_value's underlying JS function, regardless of any allow-list
state.  The future in-process tier slots in at a higher layer once we
have hot-path identifiers; until then, RPC for all.

## Example: per-op pseudocode (napi_create_function)

```ts
// In host-worker.ts (NOT in this file — that's the per-op agent's job)

import { makeHostSideCallbackClosure } from "./callback-dispatch";

server.register(OP_NAPI_CREATE_FUNCTION, async (_ctx, args) => {
  // Decode args: env, utf8namePtr, length, cbPtr, dataPtr, resultPtr
  const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
  const env       = dv.getUint32(0,  true);
  const namePtr   = dv.getUint32(4,  true);
  const length    = dv.getUint32(8,  true);
  const cbPtr     = dv.getUint32(12, true);
  const dataPtr   = dv.getUint32(16, true);
  const resultPtr = dv.getUint32(20, true);

  // Build the host-side closure that round-trips to wasm.
  const closure = makeHostSideCallbackClosure({
    reverseClient: hostSideReverseSyncClient,  // injected at boot
    cbPtr,
    dataPtr,
    env,
  });

  // Hand emnapi a JS function it can install as the napi_value's
  // underlying function.  emnapi's createFunction internally allocates
  // the value handle and writes it to resultPtr.
  //
  // (Exactly HOW we slot `closure` into emnapi's value space is the
  // per-op agent's call — likely by calling host's emnapi internals
  // directly, since the napi C API doesn't expose a "wrap arbitrary
  // JS function" entry point.  See napi-host/index.ts for the
  // in-process precedent.)

  const fnHandle = installAsNapiFunction(env, closure);
  // Write the handle to wasm memory at resultPtr.
  hostMemoryU32[resultPtr >>> 2] = fnHandle;
  return { payload: EMPTY, status: napi_ok };
});
```

The per-op agent owns the `installAsNapiFunction` plumbing — it has to
match the host's emnapi value-space conventions.  The dispatcher
itself doesn't care.

## Wiring notes for the per-op batch

1. **Host worker** (`host-worker.ts`) needs a new `SyncRpcClient`
   instance bound to the **reverse-direction** rings
   (`reverseRequestRing`, `reverseReplyRing`).  Today only an async
   `RpcClient` is constructed there.  The sync variant lets
   `makeHostSideCallbackClosure` produce a synchronous closure —
   emnapi's `withScope` wrapper does NOT await.

   Construction:
   ```ts
   const hostSideReverseSyncClient = new SyncRpcClient(
     reverseRequestRing,
     reverseReplyRing,
     sharedWake,
     // no drainReverseRequests — the host is the SENDER on this channel;
     // no further reverse direction exists from here.
   );
   ```

2. **Wasm runtime worker** (`worker.ts`) needs to call
   `registerWasmCallbackInvoker` once after `napi.bindInstance` so
   `__indirect_function_table` is the real one (not the stub).

3. **Synthetic CallbackInfo** (#!~debt in `callback-dispatch.ts`): the
   wasm-side handler currently invokes the funcref with `(env,
   cbinfo=0)`.  Wasm callbacks that call `napi_get_cb_info` will see
   an invalid handle.  When the first per-op agent needs a callback
   to actually receive its args via `napi_get_cb_info`, that agent
   wires a "build synthetic CallbackInfo from (env, args[], dataPtr)"
   hook into the dispatcher.  Until then, the dispatcher proves its
   plumbing works for callbacks that don't introspect their args.

## What this spec does NOT cover

  * `napi_add_finalizer` — finalizer dispatch is a different shape
    (host-driven, not call-driven); the per-op agent for that op
    will likely build on top of the same reverse channel but with
    its own marshalling.
  * Thread-safe function dispatch — multi-thread fan-out is the F-10
    layer; out of scope here.
  * In-process tier wiring — see `callback-triage.ts` for policy;
    actual wiring lives in `napi-host/index.ts:570-610` (already
    present for the in-process napi-host).
