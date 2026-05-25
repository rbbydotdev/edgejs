# e31 — Wasm-side MessageChannel facade → host roundtrip

## Original hypothesis (going in)

Phase 4 of worker_threads needs `new MessageChannel()` to work on the
user side.  Plan: wrap browser-native `globalThis.MessageChannel` via
new napi bindings, mirroring the architecture of existing host-routed
crypto/zlib ops.  Three layers to build: lib JS facade, napi bridge,
host JS implementation.

## Actual finding (going out)

**The wrapping plan was unnecessary.**  `src/internal_binding/binding_messaging.cc`
already contains a 5,109-line implementation of `MessagePort` /
`MessageChannel` mirroring Node's `node_messaging.cc` — including
mutex+deque queueing, transferList machinery, and structuredClone
support.

What was broken: a **silent data loss** in the host-side
`unofficial_napi_{serialize,deserialize,release}_value` implementations.
Every payload arrived as `null`, regardless of sent value.

## Root cause

`browser-target/src/napi-host/unofficial.ts` (pre-fix lines 705-739)
serialized payloads into a fresh ArrayBuffer, then stored a napi_value
handle to that AB.  The C++ side (binding_messaging.cc) stored the
handle as `void*` in its Message queue and passed it back to
deserialize **from a different napi callback scope** — by which time
emnapi had freed the handle, leaving deserialize with a dangling
reference.  `jsValueFromNapiValue` returned `undefined`; the
deserializer fell to its `null` fallback.  Every payload silently
became `null`.

This is a textbook handle-lifetime mismatch: short-lived napi handles
crossing long-lived C++ ownership.

## Fix

Replace the napi handle round-trip with a host-owned `Map<id, Uint8Array>`
keyed by an opaque ID.  C++ receives the ID (as a `void*`), stores it,
passes it back to deserialize.  The Map keeps the bytes alive across
callback boundaries.  Release deletes the entry.

40-line diff in `browser-target/src/napi-host/unofficial.ts`.  No C++
changes.  No wasm rebuild.

Also fixed: `JSON.stringify(undefined)` returns `undefined` (literally,
not a string), which broke any caller passing `undefined`.  Added a
sentinel-string round-trip so undefined survives serialize/deserialize.

## Verification

Test: `tests/js/e31-messagechannel-roundtrip-types.js` — exercises
postMessage roundtrip for 7 data types in a tight loop:
string, number, boolean, null, undefined, object, array.

Pre-fix: 7/7 types arrive as `null`.
Post-fix: 7/7 types roundtrip with `match=true`.

Stability: 5/5 runs of the test.
Full suite: 43 pass, 0 fail, 0 err, 3 pre-existing skips
(up from 42 — the new test is the +1; no regressions).

## What this DOESN'T cover

- Cross-worker MessagePort transfer (port object itself as
  transferable across worker boundary).  Deferred to e32.
- Structured-clone transferables (ArrayBuffer transfer with detach,
  MessagePort transfer).  The current serializer is JSON-based and
  won't handle these correctly.  Deferred to e33.
- Complex types: Map, Set, Date, RegExp, TypedArray, Buffer.
  JSON-based serialization loses these.  Deferred to e33.
- Circular references.  JSON.stringify will throw on these.  Documented
  divergence from Node (which uses ValueSerializer for structured
  clone).  Deferred to e33.

## Files state

- `browser-target/src/napi-host/unofficial.ts` — PATCHED
  (~40-line diff to serialize/deserialize/release trio).
- `tests/js/e31-messagechannel-roundtrip-types.{js,stdout}` — KEPT as
  permanent regression test.  Catches silent-data-loss class of bugs.
- No C++ changes.  No wasm rebuild needed (host-only fix).

## Recommendation

**Ship.**  Closes silent data loss in single-isolate MessageChannel
postMessage.  Foundation for phase 4 cross-worker work (e32+).

The "MessageChannel deadlock" item originally framed in conversation
turned out to be a different shape than expected: not a deadlock,
not even a missing implementation — just a serialization bug in the
host layer.  Wasm-side C++ implementation has always been Node-correct.
