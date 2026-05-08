# N-API Compat: QuickJS Utilities

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility utilities documented from `napi/quickjs/src/compat/quickjs_utilities.{h,cc}`. |
| **Severity** | Low | Shared helpers are not a feature by themselves, but mistakes here spread widely. |

## Source Pair

- `napi/quickjs/src/compat/quickjs_utilities.h`
- `napi/quickjs/src/compat/quickjs_utilities.cc`

## What It Does

The utilities pair holds shared helpers used by the other compatibility adapters. This includes QuickJS value handling, string conversion, file URL and path conversion, source loading, symlink-sensitive path work, and small wrappers that keep adapter code from duplicating fragile QuickJS boilerplate.

## Why It Is Needed

The compatibility layer touches module loading, contextify, serialization, globals, and environment state. All of those areas need similar low-level conversions between C++ strings, filesystem paths, JS values, and QuickJS atoms. A separate utility pair keeps those mechanics out of the concern-specific adapters and reduces the risk that each adapter invents slightly different path or value handling.

## Could We Do It Better

This file should remain deliberately boring. Over time, pure helpers that are not compatibility-specific can move into `napi/quickjs/src/internal`, while loader-specific helpers can stay near module loading. The main improvement is to keep drawing the line between general QuickJS utilities and Node-compatibility policy so this file does not become another unstructured dumping ground.
