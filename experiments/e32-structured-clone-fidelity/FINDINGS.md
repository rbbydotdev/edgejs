# e32 — Structured-clone fidelity in MessageChannel postMessage

## Note: original scope pivoted

The original framing for e32 was "cross-worker MessagePort transfer."  A
quick probe showed that's blocked on something more fundamental: the
host-side serializer (just fixed in e31 from null-loss to JSON-based)
couldn't carry **ArrayBuffer, TypedArray, Map, Set, Date, RegExp,
transferList**.  These are all structured-cloneable types Node's
postMessage handles natively via V8 ValueSerializer; ours dropped them.

Without those, cross-worker `port.postMessage(ab, [ab])` was guaranteed
to fail at the data layer regardless of any transferList plumbing.

So e32 pivoted to **structured-clone fidelity first**, cross-worker
transfer (next experiment) second.

## Verdict: **GREEN — 8/8 structured-cloneable types roundtrip cleanly**

Fix: replace the host-side serializer's JSON-stringify/parse with
browser-native `structuredClone()`.  Store the cloned JS value
directly (not bytes) keyed by an opaque ID in the same host-owned
Map e31 introduced.

## Test results

`tests/js/e32-messagechannel-structured-clone.js` × 5 runs:

| Type        | Verdict |
|-------------|---------|
| ArrayBuffer | ✅ 5/5  |
| Uint8Array  | ✅ 5/5  |
| Int32Array  | ✅ 5/5  |
| Date        | ✅ 5/5  |
| RegExp      | ✅ 5/5  |
| Map         | ✅ 5/5  |
| Set         | ✅ 5/5  |
| nested      | ✅ 5/5  |

Pre-fix: ArrayBuffer arrived as `{}`, TypedArrays as `{0:1,1:2,...}` (JSON-stringified),
Map/Set as `{}`, Date as ISO string, RegExp as `{}`.  Almost everything but
plain objects was effectively lost.

Post-fix: all types roundtrip via `instanceof` + content checks.  Each test
case explicitly verifies type identity (instanceof) AND content (bytes,
keys, members) match.

Full suite: 44 pass, 0 fail, 0 err, 3 pre-existing skips (the +1 is the
new e32 test).  No regressions.

## Patch

40-line diff to `browser-target/src/napi-host/unofficial.ts`:
- `unofficial_napi_serialize_value` — wraps the value in
  `structuredClone()`.  Caught exceptions fall back to `null` (matches
  prior silent-loss behavior, no new error class).
- `unofficial_napi_deserialize_value` — looks up the cloned value by ID
  from the Map (set-by-serialize), passes to `napiValueFromJsValue`.
  Uses `Map.has()` to distinguish "stored undefined" from "missing id".
- `unofficial_napi_release_serialized_value` — Map delete.
- Store type changed from `Map<number, Uint8Array>` (e31) to
  `Map<number, unknown>` (cloned values, not bytes).
- Removed unused `encoder` constant (was only used by old JSON path).

Saved patch: `patch.diff`.

## Known limitations (not in e32 scope)

1. **Circular references**: blow up the C++-side
   `PrepareTransferableDataForStructuredClone` walker
   (`binding_messaging.cc`) with "Maximum call stack size exceeded"
   BEFORE our serializer is called.  Cycle detection in C++ needs
   adding (+ wasm rebuild).  Verified isolated repro.

2. **transferList detach**: `port.postMessage(ab, [ab])` delivers AB
   data correctly (receiver gets a fresh AB with the right bytes), BUT
   source AB is NOT detached (`ab.byteLength` stays > 0).  Reason: the
   napi `unofficial_napi_serialize_value` signature has no transferList
   slot (3 args: env, value, payload_out).  Per-spec strict detach
   needs the napi signature extended or a side-channel.  Memory-only
   issue, not data-loss.

3. **Cross-worker MessagePort transfer**: separate experiment.  The
   payload layer is now solid enough to support it; remaining work is
   the cross-worker addressing/routing for transferred ports.

4. **`MessagePort`-as-value transfer**: structuredClone returns a
   native browser MessagePort, not our edge.js MessagePort, when one
   is transferred.  Cross-worker port transfer (limitation 3) will
   need a different mechanism than the host structuredClone — likely
   a port-ID registry.

## State of main

- `browser-target/src/napi-host/unofficial.ts` — PATCHED
- `tests/js/e32-messagechannel-structured-clone.{js,stdout}` — KEPT
  as permanent regression test
- No C++ changes; no wasm rebuild needed (host-only fix)

## Recommendation

Ship.  Closes a much wider class of silent-data-loss than e31 did.

Next: e33 = cross-worker MessagePort transfer (the original e32 framing).
The payload layer is solid enough now to make that meaningful — pre-e32
it would have been thwarted by the serializer regardless.

(Or alternatively: e33 = circular-ref cycle detection in C++ walker
+ transferList detach plumbing.  Both have real value; cross-worker is
the higher-leverage user-facing surface.)
