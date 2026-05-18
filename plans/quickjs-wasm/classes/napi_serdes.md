# `quickjs::detail::napi_serdes__`

Status: Current as of 2026-05-15.

`napi_serdes__` implements QuickJS-backed serialization/deserialization helpers
for the unofficial V8-shaped serializer API.

It lives in `napi/quickjs/src/internal/napi_serdes.h` and `.cc` under the
`quickjs::detail` namespace. The class is static-only; serializer/deserializer
instances are JavaScript objects that wrap native `serializer` or
`deserializer` structs with N-API finalizers.

The lightweight serializer stores a byte vector. The deserializer stores a byte
vector plus a read offset. Primitive methods append or read little-endian
integers, doubles, and raw bytes. ArrayBuffer-like inputs are read from QuickJS
ArrayBuffer, TypedArray, or DataView values.

Structured clone helpers use QuickJS object serialization where supported:
`serialize_value(...)` returns an opaque payload buffer and
`deserialize_value(...)` reconstructs a scoped N-API value from that payload.
`release_serialized_value(...)` frees payload buffers created by the serializer.

The compatibility layer is intentionally narrow. It keeps Node-facing serdes
behavior out of public N-API entry points while preserving QuickJS exception
state or reporting N-API status on failure.
