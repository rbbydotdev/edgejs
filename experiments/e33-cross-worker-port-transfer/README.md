# e33 — Cross-worker MessagePort transfer

## Goal

`worker.postMessage(value, [port])` on the sender side delivers
`value` to the receiver with a fresh, functional MessagePort
substituted at the same position in the value tree.  Bidirectional
postMessage on the transferred port reaches its sibling across the
worker boundary.

Mirrors Node's `worker_threads` transferList semantics for MessagePort
specifically.  This is the user-facing surface for `parentPort`,
`MessageChannel`-between-workers, and the "structured-clone with
transfer" contract that real Node code depends on.

## Probe finding (going in)

Tried `__edgePackPostMessage({ port: ch.port1 })` today.  Result:

- **Pack**: succeeds, emits 43 bytes
- **Unpack** (same-isolate roundtrip via the global): throws
  `marshal: identity reference collected`

Root cause: `cross-context-marshal.ts` encodes the MessagePort via
`MARSHAL_TAG_OBJECT_BYREF` (it's a class instance, not a plain
object).  The byref tag references the sender's IdentityMap.  The
receiver creates a FRESH IdentityMap (per `marshal-postmessage.ts:34`
— intentional, since cross-isolate identity sharing is impossible),
so the reference can't be resolved and unpack throws.

This is the explicit limitation called out in
`browser-target/src/host-worker/marshal-postmessage.ts:10-14`:

> We don't share an IdentityMap because parent wasm and child wasm
> are separate V8 isolates; the `MARSHAL_TAG_OBJECT_BYREF` path
> (which requires a shared map) would never resolve anyway.

## Implementation scope (real work, ~4-6 hours MVP)

### Pieces needed

1. **New marshal tag** `MARSHAL_TAG_PORT_REF` in
   `cross-context-marshal.ts`.  Payload: a 4-byte (or 8-byte)
   port-ID.

2. **Port-ID allocation** — globally unique across the workers in the
   tab.  Two options:
   - Main thread owns the ID counter; sender does sync RPC to allocate.
   - Each worker has a (workerId, localCounter) pair → composite ID.
   Latter is simpler if collisions only need to be unique-per-message.

3. **Pack-side modification** — `packPostMessage(value, transferList)`:
   - Walk transferList; for each MessagePort, register it (in some
     local registry) under a fresh ID.
   - Inside `packValue`, detect MessagePort instances and emit
     `MARSHAL_TAG_PORT_REF` with that ID instead of trying
     OBJECT_BYREF.

4. **Unpack-side modification** — `unpackPostMessage(bytes)`:
   - Upon hitting `MARSHAL_TAG_PORT_REF`, materialize a NEW JS-side
     "port stub" (NOT the C++ MessagePort) that knows its port-ID
     and the originating worker.
   - The stub provides Node's MessagePort surface
     (`.postMessage`, `.on('message')`, `.close`, `.ref`,
     `.unref`).

5. **Stub routing** — when user calls `stub.postMessage(data)`:
   - Marshal data via the same `packPostMessage`.
   - Send via a NEW RPC op `OP_PORT_MESSAGE` to main thread,
     parameterized by destination port-ID.
   - Main routes to the worker that currently owns that port-ID.

6. **Main-thread port registry** — `Map<portId, {ownerWorkerId,
   siblingPortId | null}>`.  Populated on port creation /
   transfer.  Used by `OP_PORT_MESSAGE` to find destination.

7. **Worker.prototype.postMessage in policy patch** — currently drops
   transferList (line 293).  Replace with: call
   `packPostMessage(value, transferList)` (extended signature) to
   include the ports; cleanup local refs after.

8. **parentPort.postMessage in policy patch** — same treatment.

9. **Test**: end-to-end probe.  Parent creates channel, sends port1
   to child via worker.postMessage.  Child receives + can postMessage
   back through port1.  Parent's port2 fires `on('message')`.

### What this doesn't need

- **No C++ changes**.  The wasm-side C++ MessagePort stays single-
  isolate-only.  Cross-worker uses a JS-side stub that bypasses
  binding_messaging.cc entirely.  Two parallel mechanisms.
- **No wasm rebuild**.
- **No new napi op**.  RPC ops use the existing `OP_DOMAIN_HOST_API`
  range.

### Risks / decisions to make

- **Neuter semantics**: should the sender's port throw on subsequent
  postMessage? (Per spec, yes; cleaner to defer.)
- **Lifecycle**: when does a port-ID get garbage collected from the
  main registry? (FinalizationRegistry on stubs, plus explicit close.)
- **Multiple workers**: port can be transferred parent → child A →
  child B → ... — registry needs to handle re-transfer.  MVP: just
  parent ↔ child.

## Recommended sequence

1. Add MARSHAL_TAG_PORT_REF + minimal pack/unpack for ports.  Same-
   isolate test (just verify the marshal layer round-trips a port to
   a stub) — no cross-worker yet.
2. Add main-thread registry + OP_PORT_MESSAGE.  Test: stub round-
   trips a message to itself via main (without transferring across
   workers).
3. Cross-worker: parent registers port at creation, sends transfer
   message to child, child materializes stub, child sends back.
4. Wire into Worker.prototype.postMessage / parentPort.postMessage
   policy patches.
5. Full end-to-end test.

Each step is a sub-experiment that can stand alone.

## Decision needed

This is genuinely bigger than e26-e32 each were.  Options:

- **Push through tonight** — 4-6 hours focused.  Possible to land
  MVP but the user has been running hot all session.
- **Scope to step 1 only** — adds MARSHAL_TAG_PORT_REF + same-isolate
  pack/unpack roundtrip.  ~1 hour.  Locks in the marshal-layer
  foundation; cross-worker becomes follow-up experiments.
- **Pause** — three atomic fixes already committed today (microtask
  ordering closed, MessageChannel payload-fidelity closed).  Resume
  e33 fresh next session.

Awaiting direction.
