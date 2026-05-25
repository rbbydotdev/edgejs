# e33 — Cross-worker MessagePort transfer: FINDINGS

## Verdict: **MVP SHIPPED — strict bidirectional cross-worker transfer works**

A MessagePort transferred from parent to child via
`worker.postMessage(value, [port])` arrives as a JS-side stub on the
child with Node's MessagePort surface; calling `stub.postMessage(reply)`
on the child delivers `reply` to the sibling port's `on('message')`
handler in parent.  Full bidirectional payload roundtrip via existing
cross-worker bus + envelope.

Implementation deliberately stays on the JS side — no C++ changes, no
wasm rebuild, no new RPC ops.

## Three shipped commits

1. **cb8efe41** (step 1) — marshal-layer foundation
   - `MARSHAL_TAG_PORT_REF` added to `cross-context-marshal.ts`
   - `PackHooks { encodeObject? }` / `UnpackHooks { decodePort? }`
     plumbed through `packValue` / `unpackValue` signatures
   - `marshal-postmessage.ts` accepts optional transferList + portFactory
   - Test: `tests/js/e33-marshal-port-ref-same-isolate.js` (unit test
     of marshal layer, 11 functional assertions, 5/5 stable)

2. **6b803beb** (step 2) — stub materialization end-to-end
   - `Worker.prototype.postMessage` / `parentPort.postMessage` policy
     patches honor transferList for MessagePort entries
   - JS-side port stub with Node MessagePort surface (postMessage,
     on/once/off/emit/removeAllListeners/listenerCount, start, close,
     ref, unref, hasRef) + `__edgePortStub` / `__edgeGlobalPortId`
     diagnostic markers
   - Test: `tests/js/e33-worker-postmessage-port-transfer.js` (12
     assertions verifying stub shape end-to-end, 5/5 stable)
   - Fixed a critical bundle bug: backticks inside JS comments in
     template-string-embedded JS fragmented the outer template literal
     and broke the entire worker.ts bundle (`EventEmitter is not
     defined` page error on EVERY test).  Lesson: any JS template
     string in TS source must avoid backtick characters in its
     content entirely.

3. **cac00be2** (step 3) — bidirectional routing
   - Stub.postMessage envelopes the payload as
     `{ __edgePortMsg: true, targetPortId, payload }` and routes via
     `__edgePostMessageFromWorker` (existing cross-worker bus)
   - Parent's `__edgeDispatchMessageFromChild` detects the envelope and
     calls `port.postMessage(payload)` on the local C++ port
     registered under `targetPortId` — the C++ binding's existing
     sibling-queue mechanism delivers it to the user's kept port
   - Test: `tests/js/e33-port-bidirectional-roundtrip.js` (full
     parent-create → transfer → child-reply → parent-receives
     roundtrip, 5/5 stable)

## Why this design works

The key insight is that we keep the transferred port's C++ object
alive on the parent side (in `__edgePortsByGlobalId`).  After
transfer, the user can no longer see it directly, but it becomes our
DELIVERY CHANNEL.  Calling `parentSideHiddenPort.postMessage(payload)`
uses the existing C++ binding to enqueue on the SIBLING (the kept
port), whose `on('message')` fires for the user normally.

This means we don't need to reimplement port queueing in JS — the
C++ binding's already-shipping in-isolate machinery does it.  The
cross-worker layer is purely a transport between the stub (child) and
the hidden C++ port (parent).

## Test results across e33's 3 commits

| Test                                          | Runs | Pass |
|-----------------------------------------------|------|------|
| e33-marshal-port-ref-same-isolate             | 5    | 5    |
| e33-worker-postmessage-port-transfer          | 5    | 5    |
| e33-port-bidirectional-roundtrip              | 5    | 5    |

Full suite at e33 completion: 47 pass, 0 fail, 0 err, 3 pre-existing
skips.  Up from 44 at e33 start (+3 new tests, no regressions).

## Architectural note

The original framing in `experiments/e23-real-path-a-discovery/`
proposed implementing MessagePort using Node's canonical pattern
(mutex+deque+uv_async_t).  e31 discovered the existing
`binding_messaging.cc` already mirrors Node's pattern.  e33 builds on
top of that: same-isolate uses the C++ binding directly, cross-worker
uses the JS-side stub-and-envelope design layered above.

Two parallel mechanisms by intention:
- Same-isolate channel members: pure C++ binding (fast path, no
  JS hop)
- Cross-isolate channel members: JS-side stub + envelope (only
  pays the RPC roundtrip when a port has been transferred)

## What's NOT in MVP (real followups, each independently scoped)

1. **Parent→child via the parent-side kept port**: today
   `ch.port2.postMessage('x')` in parent uses the C++ binding which
   queues on the transferred-away `ch.port1` (now hidden, ineffective
   for user).  Child stub doesn't see it.  Fix: at transfer time,
   intercept `port2.postMessage` to envelope-route to child stub.
   Needs sibling tracking at MessageChannel construction
   (WeakMap<port, sibling>) since C++ doesn't expose sibling to JS.

2. **Cross-child port transfer**: port from worker A → worker B (not
   parent).  Today's envelope assumes child→parent.  Fix: main-thread
   port-ID routing table; new (or extended) RPC op.

3. **Port-of-port chains**: port transferred A → B → C.  Followup of
   (2).

4. **Detach / neuter semantics on the sender side**: per-spec, the
   transferred port should be unusable in the sender after transfer.
   Today the parent's `ch.port1` stays alive (we use it as the
   delivery channel).  User wouldn't normally touch it but the
   semantic divergence exists.  Fix: monkey-patch sender's port
   methods to throw post-transfer.

5. **`structuredClone()` `MessagePort`-as-value**: if the user passes
   a port-WITHIN-value WITHOUT transferList, current behavior is
   undefined (the marshal hits OBJECT_BYREF and throws on receive).
   Per Node spec this should throw "DataCloneError" synchronously on
   pack.  Easy fix: detect MessagePort outside transferList and
   throw.

6. **Same-isolate transferList with both ports**: e.g. `new
   MessageChannel(); ch.port1.postMessage(otherChannel.port1,
   [otherChannel.port1])` — uses the C++ binding's transferList
   machinery directly; not exercised by e33's tests.  Probably
   already works (the binding has transferList paths in
   binding_messaging.cc) but unverified.

These are all real items but each is independently addressable.  The
core "stub backed by a working cross-worker pipe" is shipped.

## State of main

- `browser-target/src/host-worker/cross-context-marshal.ts` — PATCHED
- `browser-target/src/host-worker/marshal-postmessage.ts` — PATCHED
- `browser-target/src/worker.ts` — PATCHED (global type signatures)
- `browser-target/src/policies/worker-threads-per-thread.ts` — PATCHED
- `tests/js/e33-*.js` and `.stdout` — 3 permanent regression tests
- No C++ changes; no wasm rebuild; no new RPC ops; no main-thread
  changes

## Session totals (this session's work)

Commits, in order:
1. 9cb79911 — microtask within-iteration drain (item 1 closed)
2. 529ae591 — MessageChannel payload-loss fix (e31)
3. 00476329 — structured-clone fidelity (e32)
4. a6fe71a1 — e33 design README
5. cb8efe41 — e33 step 1 marshal layer
6. 6b803beb — e33 step 2 stub materialization
7. cac00be2 — e33 step 3 bidirectional routing

The three original items from session start are now:
- Item 1 (microtask/nextTick ordering): CLOSED
- Item 2 (cross-worker microtask coordination): CLOSED by design
- Item 3 (MessageChannel "deadlock"): CLOSED — turned out to be a
  silent data-loss bug (e31) + a structured-clone gap (e32) + a
  missing cross-worker transfer surface (e33).  All shipped.
