# Known Issue: `NAPI_EXTERN=` WASIX linkage rule

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Linkage rule is known and enforced in current embedded-provider builds. |
| **Severity** | Medium | Correct but easy to forget on future targets. |

## Current State

This is a build and deployment issue, not a QuickJS N-API compatibility file.

## Source Notes

- `plans/quickjs-wasm/development/008_runtime_change_containment_rollback.md`
- `plans/quickjs-wasm/development/troubleshooting/wasmer-deploy/002_quickjs_wasix_napi_import_module_mismatch.md`

## Known Incompatibility

Targets that include N-API headers before linking `napi_quickjs` must compile
with `NAPI_EXTERN=` so wasm objects agree that `napi_*` symbols are provided by
the embedded provider rather than imported from `napi` or `env`.

## Risk

The rule is real, but it is tribal knowledge unless every consumer inherits it
centrally. A future target can silently compile with the wrong import/export
mode and fail at wasm link time.

## Current Status

Move embedded-provider declaration mode into a single CMake interface target or
generated config header. Make all N-API consumers inherit from it. Keep the
post-link no-imported-`napi_*` check and make failures identify the offending
target.
