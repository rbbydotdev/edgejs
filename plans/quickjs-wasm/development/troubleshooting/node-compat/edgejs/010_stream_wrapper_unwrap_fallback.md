# Known Issue: Stream wrapper-specific unwrap fallback

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Runtime stream handling works, and the underlying QuickJS N-API object/external ambiguity is fixed. |
| **Severity** | High | Previously worked around a deeper N-API object identity problem. |

## Current State

This issue crosses EdgeJS stream code and QuickJS N-API object typing. The
observable runtime issue is tracked here because it surfaced in EdgeJS stream
conversion.

## Source Notes

- `plans/quickjs-wasm/development/005_wasix_wasmer_http.md`
- `AGENTS.md`

## Historical Incompatibility

QuickJS class instances could look like `napi_external`, so stream conversion
treated a wrapped `TCP` object as a raw external pointer. The fix tries
TCP/Pipe/TTY wrapper-specific `napi_unwrap(...)` paths before raw external
fallback.

The root ambiguity is now fixed in QuickJS N-API: constructed class instances
are ordinary prototype-backed objects, while public externals and internal wrap
records use separate QuickJS classes.

## Risk

The stream fix is still a useful defensive conversion path, but wrapped objects
should no longer be ambiguous with raw external values.

## Current Status

QuickJS N-API type tagging now keeps wrapped objects and raw externals distinct.
Future cleanup can simplify stream-base conversion where the wrapper-specific
fallback is no longer needed for compatibility.
