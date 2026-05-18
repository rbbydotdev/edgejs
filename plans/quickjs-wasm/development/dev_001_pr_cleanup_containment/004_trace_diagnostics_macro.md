# Compile-time trace diagnostics

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Historical trace macro cleanup task. |
| **Severity** | Low | Diagnostic naming does not block runtime behavior. |

## Scope

Preserve the native C/C++ tracing that helped diagnose QuickJS TTY, HTTP, stream,
module, and bootstrap issues, but make it compile-time disableable so production
builds can compile the trace checks out.

## Current Implementation

- Added `src/edge_trace.h` for Edge runtime code.
- Added `napi/quickjs/src/internal/quickjs_trace.h` for QuickJS N-API code.
- Added `EDGE_ENABLE_TRACE_DIAGNOSTICS=$<IF:$<CONFIG:Debug>,1,0>` to
  `edge_runtime` and `napi_quickjs` compile definitions.
- Converted `std::getenv("EDGE_TRACE_*") != nullptr` trace checks to
  `EDGE_TRACE_ENABLED("EDGE_TRACE_*")`.

## Trace Families

Known trace switches currently covered:

- `EDGE_TRACE_BOOTSTRAP`
- `EDGE_TRACE_BUILTINS`
- `EDGE_TRACE_INTERNAL_BINDING`
- `EDGE_TRACE_NET`
- `EDGE_TRACE_QUICKJS_CONTEXTIFY`
- `EDGE_TRACE_QUICKJS_MODULES`
- `EDGE_TRACE_TTY`

## Verification Status

After rebuild, check that there are no raw `std::getenv("EDGE_TRACE_...")`
checks left in `src/` or `napi/quickjs/src/`:

```sh
rg -n 'std::getenv\("EDGE_TRACE|EDGE_TRACE_[A-Z_]+"\) != nullptr' src napi/quickjs/src
```

Also confirm a Release-style build compiles with `EDGE_ENABLE_TRACE_DIAGNOSTICS`
set to `0` and the QuickJS smoke tests still pass.

## Ownership

Code ownership for this subtask spans trace call sites in `src/` and
`napi/quickjs/src/`, plus the new trace headers and CMake compile definitions.

## Status Notes 2026-05-07

Lightweight read-only review checked:

```sh
rg -n "EDGE_ENABLE_TRACE_DIAGNOSTICS|EDGE_TRACE_ENABLED|EDGE_TRACE_[A-Z_]+|std::getenv\(|getenv\(" CMakeLists.txt napi/quickjs/CMakeLists.txt src napi/quickjs/src
rg -n "getenv\(\s*\"EDGE_TRACE|std::getenv\(\s*\"EDGE_TRACE" . --glob '!plans/**' --glob '!build*/**' --glob '!quickjs-wasm/**'
rg -n "#include .*edge_trace|#include .*quickjs_trace|EDGE_TRACE_ENABLED" src napi/quickjs/src
```

Findings:

- No raw `std::getenv("EDGE_TRACE_*")` / `getenv("EDGE_TRACE_*")` call sites
  were found outside the trace helper headers.
- Current `EDGE_TRACE_ENABLED(...)` callers include `edge_trace.h` or
  `internal/quickjs_trace.h` directly in the same translation unit.
- The reviewed CMake files define `EDGE_ENABLE_TRACE_DIAGNOSTICS` for
  `edge_runtime` and `napi_quickjs`; `edge_cli.cc` uses the header fallback
  rather than a target-specific compile definition.
- Full Release-style compile verification was not run in this review because
  this pass was intentionally limited to lightweight read-only commands.
