# Compatibility Adapter: Minimal `v8` serdes binding

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Allows `require("v8")`, but the surface name implies real V8 internals. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/next-app/001_standalone_v8_serdes.md`
- `plans/quickjs-wasm/development/007_framework_standalone_builds.md`

## What Is The Compatibility Adapter

QuickJS exports `Serializer` and `Deserializer` from
`internalBinding("serdes")` so `require("v8")` can load and basic
`v8.serialize()` / `v8.deserialize()` can round-trip plain objects.

## Why It Is Suspect

The public builtin is named `v8`, but QuickJS cannot expose true V8 serializer,
heap, coverage, profiler, or promise internals. A partial object can fail later
in surprising places.

## How To Do It Better

Create an explicit QuickJS compatibility layer for the `v8` builtin with a
support matrix: implemented, approximate, unavailable. Test serializer behavior
against Node's observable semantics, and return stable documented failures for
true V8-only features.
