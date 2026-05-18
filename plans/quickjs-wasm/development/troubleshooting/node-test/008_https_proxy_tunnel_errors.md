# Node Test: HTTPS proxy tunnel errors

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Request tunnel error formatting fixed; fetch proxy remains WebAssembly-blocked. |
| **Severity** | High | HTTPS proxy request failures need stable Node-compatible error output. |

Affected tests:

- `client-proxy/test-https-proxy-fetch`
- `client-proxy/test-use-env-proxy-cli-https`
- `client-proxy/test-https-proxy-request-empty-response`
- `client-proxy/test-https-proxy-request-malformed-response`
- `client-proxy/test-https-proxy-request-proxy-failure-404`
- `client-proxy/test-https-proxy-request-proxy-failure-500`
- `client-proxy/test-https-proxy-request-proxy-failure-502`
- `client-proxy/test-https-proxy-request-proxy-failure-hang-up`

## What Is The Issue

Current fetch-through-HTTPS-proxy failures now stop in Undici before the proxy
tunnel logic:

```text
TypeError: fetch failed
[cause]: ReferenceError: WebAssembly is not defined
```

That is shared with the HTTP fetch/proxy issue. The request-specific HTTPS
proxy tests still exercise the tunnel code and expose the error-shape issues
below.

HTTPS fetch through a proxy fails with:

```text
ERR_SSL_PACKET_LENGTH_TOO_LONG
```

That usually means TLS is being attempted against a plain proxy socket before a
successful `CONNECT` tunnel is established.

Failure-path proxy request tests do surface `ERR_PROXY_TUNNEL`, but the error
message/body is incomplete. Some test code then tries to inspect a `null` match
and throws `TypeError: cannot read property 'length' of null`; others assert
that the string should include `Connection to establish proxy tunnel ended
unexpectedly`.

## 2026-05-15 Native Error Stack Update

The six request-specific tunnel failure tests now pass without changing `lib/`.
The root cause was vendored QuickJS eagerly calling `Error.prepareStackTrace`
inside the `Error` constructor, before NodeError subclasses initialized public
class fields such as `code = 'ERR_PROXY_TUNNEL'`. Stack and inspect output
therefore showed `Error [undefined]: ...`.

QuickJS now captures call-site data at construction but defers
`prepareStackTrace(error, frames)` until `error.stack` is first read. The lazy
getter then caches the prepared stack as a normal writable/configurable own
property. This preserves Node's unchanged `lib/internal/errors.js` behavior and
produces stack output such as:

```text
Error [ERR_PROXY_TUNNEL]: Connection to establish proxy tunnel ended unexpectedly
```

Targeted verification passed:

```sh
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-request-empty-response.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-request-malformed-response.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-request-proxy-failure-404.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-request-proxy-failure-500.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-request-proxy-failure-502.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-request-proxy-failure-hang-up.mjs
```

## Remaining Work

The request-specific tunnel error formatting path is fixed. The remaining proxy
entries in this note are fetch/global proxy coverage, which currently stop in
Undici because WebAssembly is unavailable in this QuickJS test configuration.
When Wasm is back in scope, verify the full HTTPS proxy state flow:

1. open TCP/TLS connection to the proxy as configured;
2. send `CONNECT target-host:target-port HTTP/1.1`;
3. parse proxy response status and headers;
4. only wrap the socket in target TLS after a 2xx tunnel response;
5. construct stable `ERR_PROXY_TUNNEL` errors for empty, malformed, 4xx, 5xx,
   and hang-up responses.

Remaining verification:

```sh
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-fetch.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-use-env-proxy-cli-https.mjs
```
