# V8 structured clone handle scope

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | V8-backed `structuredClone()` no longer aborts on ordinary objects or pnpm startup. |
| **Severity** | High | Blocks `build-edge/edge pnpm run start` before pnpm can launch Astro. |

## Symptom

Running the V8-backed Edge binary in `stackmachine.com` fails before Astro starts:

```sh
cd /Users/syrusakbary/Development/stackmachine.com
/Users/syrusakbary/Development/edgejs/build-edge/edge pnpm run start
```

The process prints a V8 stack trace and can remain stopped or hot instead of
opening the dev server. A minimal reproduction does not need pnpm or Astro:

```sh
/Users/syrusakbary/Development/edgejs/build-edge/edge -e "structuredClone({start:'astro dev'})"
```

## Diagnosis

`pnpm` calls Node's global `structuredClone()` while reading and normalizing
`package.json`. The native backtrace for the minimal reproduction reaches:

```text
StructuredCloneCallback
CloneMessageValueWithTransfers
RestoreTransferableDataAfterStructuredClone
napi_has_named_property
v8::Object::Has
v8::internal::LookupIterator::GetRootForNonJSReceiver
v8::internal::Isolate::PushStackTraceAndDie
v8::base::OS::Abort
```

The likely cause is a V8 local handle lifetime violation in
`napi/v8/src/unofficial_napi.cc`. `StructuredCloneImpl(...)` opens a nested
`v8::HandleScope`, deserializes a cloned `v8::Value`, wraps it as `napi_value`,
and returns it to `src/internal_binding/binding_messaging.cc`. Since the V8
backend now represents `napi_value` as a direct local-handle slot, the returned
value becomes invalid when that nested scope closes. The next property probe in
`RestoreTransferableDataAfterStructuredClone(...)` then calls into V8 with a
stale handle and aborts.

This matches the existing audit in
`plans/quickjs-wasm/development/dev_004_v8_napi_lifetime_refactor/004_unofficial_napi_audit.md`:
result-producing unofficial N-API helpers must escape returned V8 locals from
nested scopes or avoid opening the nested scope.

## Action Plan

1. Keep the fix narrow to the structured-clone result path, not the broader
   unofficial N-API audit list.
2. Convert `StructuredCloneImpl(...)` to use `v8::EscapableHandleScope`.
3. Have `DeserializeTransferredClone(...)` return a V8 local result to its
   caller, then escape that local in `StructuredCloneImpl(...)` before wrapping
   it as `napi_value`.
4. Apply the same escaped-return pattern to `unofficial_napi_deserialize_value`
   because it has the same serialize/deserialize result shape.
5. Rebuild `build-edge/edge`.
6. Verify:

```sh
/Users/syrusakbary/Development/edgejs/build-edge/edge -e "const x = structuredClone({start:'astro dev'}); console.log(x.start)"
/Users/syrusakbary/Development/edgejs/build-edge/edge -e "const ab = new ArrayBuffer(4); const clone = structuredClone({ab}, {transfer:[ab]}); console.log(ab.byteLength, clone.ab.byteLength)"
cd /Users/syrusakbary/Development/stackmachine.com && /Users/syrusakbary/Development/edgejs/build-edge/edge pnpm run start
```

The `pnpm run start` check should be bounded and cleaned up after observing
that startup advances past pnpm's manifest normalization and either opens an
Astro listener or reports the next runtime issue.

## Fix

Implemented in `napi/v8/src/unofficial_napi.cc`:

- Changed `DeserializeTransferredClone(...)` to return a `v8::Local<v8::Value>`
  to its caller instead of directly wrapping a local as `napi_value`.
- Changed `StructuredCloneImpl(...)` from `v8::HandleScope` to
  `v8::EscapableHandleScope`, then escaped the deserialized local before
  converting it to `napi_value`.
- Applied the same escaped-return pattern to
  `unofficial_napi_deserialize_value(...)`, which uses the same
  serializer/deserializer result shape.

This keeps the returned direct local handle alive in the caller's parent handle
scope, matching the direct local-handle `napi_value` design.

## Verification

Rebuilt:

```sh
cmake --build /Users/syrusakbary/Development/edgejs/build-edge --target edge -j4
```

Passed:

```sh
/Users/syrusakbary/Development/edgejs/build-edge/edge -e "const x = structuredClone({start:'astro dev', nested:{ok:true}}); console.log(x.start, x.nested.ok)"
# astro dev true

/Users/syrusakbary/Development/edgejs/build-edge/edge -e "const ab = new ArrayBuffer(4); const clone = structuredClone({ab}, {transfer:[ab]}); console.log(ab.byteLength, clone.ab.byteLength)"
# 0 4

/Users/syrusakbary/Development/edgejs/build-edge/edge -e "const v8 = require('v8'); const x = v8.deserialize(v8.serialize({a:1, b:{c:2}})); console.log(x.a, x.b.c)"
# 1 2

/Users/syrusakbary/Development/edgejs/build-edge/edge /Users/syrusakbary/Development/edgejs/test/parallel/test-v8-serdes.js
```

Bounded `stackmachine.com` startup now advances through pnpm and starts Astro:

```text
astro  v5.17.2 ready in 977 ms
Local    http://localhost:4321/
```

The verification process tree was killed after the bounded run.

## Residual Issues

These are separate structured-clone semantic gaps, not the V8 handle-scope abort:

- `test/parallel/test-structuredClone-global.js` still fails when cloning a
  transferable `ReadableStream`.
- `test/parallel/test-structuredClone-domexception.js` still misses an expected
  `DataCloneError` for DOMException transfer.
