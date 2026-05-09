# Known Issue: Contextify diagnostics

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented as `napi_contextify__` under `napi/quickjs/src/internal`. |
| **Severity** | High | Contextify is central to script compilation, source metadata, and framework bootstraps. |

## Current State

Contextify helpers and state live in:

- `napi/quickjs/src/internal/napi_contextify.h`
- `napi/quickjs/src/internal/napi_contextify.cc`

`napi_env__` owns `napi_contextify__`. Source-map settings and callback state
are kept with that class instead of in removed compatibility files.

## Known Incompatibility

Node's contextify APIs sit under `vm`, internal loaders, and framework
bootstraps. QuickJS can compile and evaluate scripts, but its diagnostics and
context model do not naturally match V8 objects. Compile-time failures can be
annotated while QuickJS still exposes useful metadata. A caught `Error` returned
from JavaScript does not currently provide the same reliable V8-style message
object for preserved source-map output.

## Current Status

A fuller design should keep contextify as a small QuickJS subsystem with
explicit compiled-script objects, cache-data policy, source-map state, and
structured diagnostics. The documentation and tests should clearly separate
supported QuickJS diagnostics from V8-only caught-error formatting.
