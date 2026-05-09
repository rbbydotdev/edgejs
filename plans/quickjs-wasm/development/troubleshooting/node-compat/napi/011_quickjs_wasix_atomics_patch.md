# Known Issue: QuickJS WASIX atomics guard patch

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open engine-maintenance issue. |
| **Severity** | Medium | Local engine patch must be preserved across QuickJS updates. |

## Current State

This note tracks a QuickJS engine-level change that supports the QuickJS
runtime on WASIX. It is not part of a removed N-API compatibility directory.

## Source Notes

- `plans/quickjs-wasm/development/005_wasix_wasmer_http.md`
- `plans/quickjs-wasm/development/006_framework_app_adapters.md`
- `AGENTS.md`

## Known Incompatibility

Vendored QuickJS was patched so WASIX builds expose `Atomics` and
`SharedArrayBuffer` when `__wasm_atomics__` is defined, instead of excluding all
`__wasi__` targets.

## Risk

It may be correct, but it is still a local engine fork delta. It can be lost or
misapplied when updating QuickJS.

## Current Status

Turn the change into an explicit patch file with rationale and upstream context,
or move to a QuickJS/QuickJS-NG version that supports WASIX atomics cleanly. Add
build-time and runtime smoke tests for `Atomics`, `SharedArrayBuffer`, and
blocking-wait limitations.
