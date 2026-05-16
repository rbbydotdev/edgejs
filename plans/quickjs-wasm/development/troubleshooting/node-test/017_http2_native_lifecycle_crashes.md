# Node Test: HTTP/2 native lifecycle crashes

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in the QuickJS N-API object/external classification layer. |
| **Severity** | High | Signal 10/11 crashes affected a large HTTP/2 test cluster and could terminate the QuickJS CLI. |

## Symptoms

QuickJS crashed with SIGBUS/SIGSEGV in HTTP/2 tests such as:

```text
test/parallel/test-http2-socket-proxy-handler-for-has.js
test/sequential/test-http2-timeout-large-write.js
test/sequential/test-http2-timeout-large-write-file.js
```

LLDB showed the crash under `WriteChunksToParent(...)` /
`FlushSessionOutput(...)`, after HTTP/2 attempted to write pending session bytes
through the parent stream.

## Root Cause

`SessionConsume()` stored the result of `EdgeStreamBaseFromValue(socket._handle)`
as the HTTP/2 parent stream. QuickJS N-API constructed native class instances
with the same QuickJS class used for `napi_create_external(...)`, so
`napi_typeof()` reported wrapped objects such as `TLSWrap` as `napi_external`.
The generic stream extraction path then accepted the wrapped native object
pointer directly.

For TLS sockets that meant HTTP/2 sometimes stored a `TlsWrap*` as if it were an
`EdgeStreamBase*`. Later writes read the stream ops table from the wrong offset
and jumped through heap data.

## Fix

The fix stays outside `lib/` and keeps the EdgeJS shared native stream code
unchanged:

- QuickJS N-API constructor calls now create ordinary prototype-backed objects,
  not objects of the external class.
- `napi_typeof()` reports `napi_external` only for actual values created by
  `napi_create_external(...)`.
- `napi_get_value_external()` rejects non-external values instead of returning a
  wrapped object's native pointer.

## Verification

Targeted QuickJS checks passed after rebuilding `build-edge-quickjs-cli/edge`:

```sh
build-edge-quickjs-cli/edge test/parallel/test-http2-socket-proxy-handler-for-has.js
build-edge-quickjs-cli/edge test/sequential/test-http2-timeout-large-write.js
build-edge-quickjs-cli/edge test/sequential/test-http2-timeout-large-write-file.js
build-edge-quickjs-cli/edge test/parallel/test-http2-too-many-settings.js
build-edge-quickjs-cli/edge test/parallel/test-http2-multiplex.js
build-edge-quickjs-cli/edge test/parallel/test-http2-forget-closed-streams.js
```

Shared native regression checks passed after rebuilding `build-edge/edge`:

```sh
build-edge/edge test/parallel/test-http2-socket-proxy-handler-for-has.js
build-edge/edge test/sequential/test-http2-timeout-large-write.js
build-edge/edge test/parallel/test-buffer-constants.js
```
