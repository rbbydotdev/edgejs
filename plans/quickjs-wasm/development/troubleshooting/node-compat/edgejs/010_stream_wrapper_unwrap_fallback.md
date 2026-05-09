# Known Issue: Stream wrapper-specific unwrap fallback

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Runtime stream handling works, but the underlying N-API object identity issue remains. |
| **Severity** | High | Works around a deeper N-API object identity problem. |

## Current State

This issue crosses EdgeJS stream code and QuickJS N-API object typing. The
observable runtime issue is tracked here because it surfaced in EdgeJS stream
conversion.

## Source Notes

- `plans/quickjs-wasm/development/005_wasix_wasmer_http.md`
- `AGENTS.md`

## Known Incompatibility

QuickJS class instances could look like `napi_external`, so stream conversion
treated a wrapped `TCP` object as a raw external pointer. The fix tries
TCP/Pipe/TTY wrapper-specific `napi_unwrap(...)` paths before raw external
fallback.

## Risk

The stream fix is careful, but a wrapped object should not be ambiguous with a
raw external. This keeps HTTP working while leaving the N-API type model blurry.

## Current Status

Fix QuickJS N-API type tagging so wrapped objects and raw externals are
distinct. Make `napi_typeof`, `napi_unwrap`, and external handling match
Node-API semantics. Then simplify stream-base conversion once object identity is
trustworthy.
