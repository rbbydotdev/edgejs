# Hack: `NAPI_EXTERN=` WASIX linkage rule

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Correct but easy to forget on future targets. |

## Source Notes

- `plans/quickjs-wasm/development/008_runtime_change_containment_rollback.md`
- `plans/quickjs-wasm/development/troubleshooting/wasmer-deploy/002_quickjs_wasix_napi_import_module_mismatch.md`

## What Is The Hack

Targets that include N-API headers before linking `napi_quickjs` must compile
with `NAPI_EXTERN=` so wasm objects agree that `napi_*` symbols are provided by
the embedded provider rather than imported from `napi` or `env`.

## Why It Is Suspect

The rule is real, but it is tribal knowledge unless every consumer inherits it
centrally. A future target can silently compile with the wrong import/export
mode and fail at wasm link time.

## How To Do It Better

Move embedded-provider declaration mode into a single CMake interface target or
generated config header. Make all N-API consumers inherit from it. Keep the
post-link no-imported-`napi_*` check and make failures identify the offending
target.
