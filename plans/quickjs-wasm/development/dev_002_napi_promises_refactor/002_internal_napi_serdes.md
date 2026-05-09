# Internal N-API Serdes Refactor

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Serdes state is owned by `napi_serdes__`; native QuickJS tests pass. |
| **Severity** | Medium | Serialization behavior is observable through unofficial N-API and framework imports. |

## Scope

Serdes state lives in:

```text
napi/quickjs/src/internal/napi_serdes.h
napi/quickjs/src/internal/napi_serdes.cc
```

`napi_serdes__` owns serializer/deserializer state and keeps
`unofficial_napi.cc` focused on public entry points.

## Verification

Run from `/Users/sadhbh/src/dev/edgejs/napi`:

```sh
make test-native-quickjs
```

Run V8 too if the shared tests or headers are touched in a way that may affect
both engines.

## Current State

- `napi_serdes__` owns the serializer, deserializer, and serialized payload
  native state.
- `unofficial_napi.cc` delegates serialize/deserialize payload handling to
  `napi_serdes__` and uses the internal serdes callback methods for
  `internalBinding("serdes")`.
- `quickjs/CMakeLists.txt` builds `src/internal/napi_serdes.cc`.

## Verification Result

Run from `/Users/sadhbh/src/dev/edgejs/napi`:

```sh
make test-native-quickjs
```

Result: passed, 45/45 QuickJS N-API tests passing.
