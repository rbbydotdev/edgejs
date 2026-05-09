# Known Issue: Serialization and deserialization

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented as `napi_serdes__` under `napi/quickjs/src/internal`. |
| **Severity** | Medium | Node internals and frameworks may import V8 serialization bindings even outside V8. |

## Current State

Serialization state and callbacks live in:

- `napi/quickjs/src/internal/napi_serdes.h`
- `napi/quickjs/src/internal/napi_serdes.cc`

`napi_serdes__` owns serializer, deserializer, and serialized-payload state.
`unofficial_napi.cc` delegates into that class.

## Known Incompatibility

Node exposes V8 serialization through internal and public-facing paths, and some
framework code imports those paths even when it only needs a subset of behavior.
QuickJS has its own serialization format rather than V8's wire format.

## Current Status

Maintain a support matrix that clearly separates Node-compatible wire
semantics, QuickJS-only serialization, and unsupported V8 behavior. If exact V8
wire compatibility is required, return explicit failures instead of silently
producing incompatible bytes.
