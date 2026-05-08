# Compatibility Adapter: Native QuickJS bootstrap and contextify shims

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Contextify is a broad V8-shaped unofficial N-API surface. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

## Source Notes

- `plans/quickjs-wasm/development/002_native_bootstrap_contextify.md`
- `plans/quickjs-wasm/development/007_framework_standalone_builds.md`

## What Is The Compatibility Adapter

QuickJS needed env initialization and contextify compile behavior shaped enough
for Node bootstrap, `ContextifyScript`, source names, and framework startup
paths.

## Why It Is Suspect

Contextify can become a growing pile of special cases for whichever bootstrap
path fails next. Copying V8 assumptions too directly into QuickJS can also
create incorrect ownership, realm, or compile-error behavior.

## How To Do It Better

Treat contextify as a subsystem. Document QuickJS semantics for script
lifetime, cached data, compile errors, filename/line offsets, realms, and source
maps. Compare observable behavior with the V8 backend, and add targeted tests
before changing framework bootstrap behavior.
