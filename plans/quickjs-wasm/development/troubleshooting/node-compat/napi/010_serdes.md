# N-API Compat: Serdes

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/serdes.{h,cc}`. |
| **Severity** | Medium | Node internals and frameworks may import V8 serialization bindings even outside V8. |

## Source Pair

- `napi/quickjs/src/compat/serdes.h`
- `napi/quickjs/src/compat/serdes.cc`

## What It Does

The serialization adapter implements the available QuickJS-backed pieces of Node/V8-style serialization and deserialization. It uses QuickJS object write/read support where possible and carries the native state needed by the unofficial `serdes` binding surface.

## Why It Is Needed

Node exposes V8 serialization through internal and public-facing paths, and some framework code imports those paths even when it only needs a subset of behavior. QuickJS has its own serialization format rather than V8's wire format. This adapter gives embedders stable symbols and practical behavior for supported values while keeping the V8-specific mismatch visible.

## Could We Do It Better

The best improvement is a documented support matrix that clearly separates Node-compatible wire semantics, QuickJS-only serialization, and unsupported V8 behavior. If exact V8 compatibility is required, this adapter should return explicit failures instead of silently producing incompatible bytes. If practical framework support is the goal, tests should focus on the real values those frameworks serialize.

## Reconciled Notes

This article replaces the earlier minimal V8 serdes note. The implementation has been extracted into `napi/quickjs/src/compat` and documented by concern.
