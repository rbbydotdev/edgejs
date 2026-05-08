# N-API Compat: Contextify

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/contextify.{h,cc}`. |
| **Severity** | High | Contextify is central to script compilation, source metadata, and framework bootstraps. |

## Source Pair

- `napi/quickjs/src/compat/contextify.h`
- `napi/quickjs/src/compat/contextify.cc`

## What It Does

The contextify adapter carries helper logic for QuickJS-backed script compilation and error annotation. It translates QuickJS compile/runtime failures into the metadata shape expected by the V8-style contextify surface, including filenames, source positions, and source-map-related details used by diagnostics.

## Why It Is Needed

Node's contextify APIs sit under `vm`, internal loaders, and framework bootstraps. QuickJS can compile and evaluate scripts, but its diagnostics and context model do not naturally match the V8 objects that Node internal code expects. Keeping this translation in a dedicated adapter makes the mismatch explicit and keeps `unofficial_napi.cc` focused on the public symbol surface.

## Could We Do It Better

A fuller design would model contextify as a small QuickJS subsystem with explicit compiled-script objects, cache-data policy, source-map state, and structured diagnostics. That would be easier to test than one-off translation helpers. It would also make it clearer which V8-specific features are supported, approximated, or intentionally unavailable on QuickJS.

## Reconciled Notes

This article replaces the earlier root-level contextify bootstrap compatibility note. The implementation has been extracted into `napi/quickjs/src/compat` and is now documented by concern.
