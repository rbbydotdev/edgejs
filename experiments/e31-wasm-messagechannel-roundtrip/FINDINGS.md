# e31 — MessageChannel roundtrip: FINDINGS

## Verdict: **GREEN — silent data loss fixed, single-isolate roundtrip works**

The pre-existing `MessagePort`/`MessageChannel` C++ binding (5,109 lines
in `src/internal_binding/binding_messaging.cc` mirroring Node's
`node_messaging.cc`) was correct.  Bug was in the host-side
`unofficial_napi_{serialize,deserialize,release}_value` lifecycle:
napi_value handles to serialized payloads didn't survive across napi
callback scopes, so every received payload arrived as `null`.

## Test results

7 data types × 5 runs each via `tests/js/e31-messagechannel-roundtrip-types.js`:

| Type     | Sent              | Got              | Match |
|----------|-------------------|------------------|-------|
| string   | `"hello"`         | `"hello"`        | ✅ 5/5 |
| number   | `42`              | `42`             | ✅ 5/5 |
| boolean  | `true`            | `true`           | ✅ 5/5 |
| null     | `null`            | `null`           | ✅ 5/5 |
| undefined| `undefined`       | `undefined`      | ✅ 5/5 |
| object   | `{a:1,b:'x'}`     | `{a:1,b:'x'}`    | ✅ 5/5 |
| array    | `[1,2,3]`         | `[1,2,3]`        | ✅ 5/5 |

**Pre-fix: 7/7 = null.  Post-fix: 7/7 roundtrip correctly.**

Full suite: 43 pass, 0 fail, 0 err, 3 pre-existing skips (the +1 is
the new test; no regressions in any other test).

## Patch

40-line diff to `browser-target/src/napi-host/unofficial.ts`:
- Replace napi-handle-based payload storage with host-owned
  `Map<number, Uint8Array>` keyed by opaque ID.
- Preserve `undefined` via sentinel round-trip
  (`__edgeSerialUndefined__`).
- Make release actually delete from the Map.

Saved as `patch.diff`.

## Why this works

Before: serialize creates a JS ArrayBuffer → wraps in napi_value handle
→ returns handle to C++ which stores as void*.  Different callback
later: C++ passes handle to deserialize → emnapi has freed the handle
since the original scope closed → `jsValueFromNapiValue` returns
undefined → fallback to `null`.

After: serialize encodes bytes → stores in host-owned Map under fresh
ID → returns ID to C++.  Different callback later: C++ passes ID to
deserialize → Map lookup returns the bytes (kept alive by the Map) →
JSON.parse → returns the original value.  Release deletes the entry.

The fix sidesteps napi handle scoping entirely.  The Map is the
authoritative store.

## What this doesn't cover (followup experiments)

- **e32**: cross-worker MessagePort transfer (port object as transferable
  across worker boundary; involves main-thread routing).
- **e33**: structured-clone fidelity — Map/Set/Date/RegExp/Buffer/
  TypedArray/ArrayBuffer-transfer/MessagePort-as-transferable/
  circular refs.  Current JSON-based serializer loses these.
  ValueSerializer-equivalent implementation needed.
- **e34**: deadlock canary — simultaneous close, large message floods,
  close-while-in-flight.

## State of main

- `browser-target/src/napi-host/unofficial.ts` — PATCHED
- `tests/js/e31-messagechannel-roundtrip-types.{js,stdout}` — KEPT as
  permanent regression test
- No C++ changes; no wasm rebuild needed (host-only fix)

## Recommendation

Ship.  Closes a silent data loss bug that's been latent in the codebase
(any code path that hit MessageChannel postMessage would have lost its
payload silently with no error).  The 5,109-line C++ binding is now
actually usable for what it was built for.

The next sharp question is whether to do e32 (cross-worker transfer —
the "real" phase 4 surface) or e33 (richer structured clone) first.
e32 unblocks more user-visible Node API (parentPort, MessageChannel
between Workers); e33 makes any postMessage usage feel less surprising
when users pass Date/Map etc.

Both are real work.  Recommend e32 next — it's the user-facing surface
that matters for "Astro etc. runs."
