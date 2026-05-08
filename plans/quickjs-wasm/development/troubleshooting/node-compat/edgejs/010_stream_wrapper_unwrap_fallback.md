# Compatibility Adapter: Stream wrapper-specific unwrap fallback

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | High | Works around a deeper N-API object identity problem. |

## Implementation Home

This note tracks compatibility behavior implemented in EdgeJS runtime source under `src/`. The related N-API compatibility adapters from this cleanup effort have been extracted into `napi/quickjs/src/compat` and are documented under `node-compat/napi`.

## Source Notes

- `plans/quickjs-wasm/development/005_wasix_wasmer_http.md`
- `AGENTS.md`

## What Is The Compatibility Adapter

QuickJS class instances could look like `napi_external`, so stream conversion
treated a wrapped `TCP` object as a raw external pointer. The fix tries
TCP/Pipe/TTY wrapper-specific `napi_unwrap(...)` paths before raw external
fallback.

## Why It Is Suspect

The stream fix is careful, but a wrapped object should not be ambiguous with a
raw external. This compatibility adaptation keeps HTTP working while leaving the N-API type
model blurry.

## How To Do It Better

Fix QuickJS N-API type tagging so wrapped objects and raw externals are
distinct. Make `napi_typeof`, `napi_unwrap`, and external handling match
Node-API semantics. Then simplify stream-base conversion once object identity is
trustworthy.
