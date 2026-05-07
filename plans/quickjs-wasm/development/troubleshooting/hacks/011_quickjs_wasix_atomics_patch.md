# Hack: QuickJS WASIX atomics guard patch

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Local engine patch must be preserved across QuickJS updates. |

## Source Notes

- `plans/quickjs-wasm/development/005_wasix_wasmer_http.md`
- `plans/quickjs-wasm/development/006_framework_app_adapters.md`
- `AGENTS.md`

## What Is The Hack

Vendored QuickJS was patched so WASIX builds expose `Atomics` and
`SharedArrayBuffer` when `__wasm_atomics__` is defined, instead of excluding all
`__wasi__` targets.

## Why It Is Suspect

It may be correct, but it is still a local engine fork delta. It can be lost or
misapplied when updating QuickJS.

## How To Do It Better

Turn the change into an explicit patch file with rationale and upstream context,
or move to a QuickJS/QuickJS-NG version that supports WASIX atomics cleanly. Add
build-time and runtime smoke tests for `Atomics`, `SharedArrayBuffer`, and
blocking-wait limitations.
