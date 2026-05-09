# Node Test: HTTPS proxy tunnel errors

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | High | HTTPS proxy support is observably incorrect across success and failure paths. |

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

## How Should We Fix It

Separate HTTPS proxy handling into explicit states:

1. open TCP/TLS connection to the proxy as configured;
2. send `CONNECT target-host:target-port HTTP/1.1`;
3. parse proxy response status and headers;
4. only wrap the socket in target TLS after a 2xx tunnel response;
5. construct stable `ERR_PROXY_TUNNEL` errors for empty, malformed, 4xx, 5xx,
   and hang-up responses.

The fix belongs in the HTTP/HTTPS client proxy connection path, and should be
shared by global `fetch()` and `https.request()` where possible. Preserve the
proxy response body or status text in the error message where the tests expect
it.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-fetch.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-use-env-proxy-cli-https.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-request-empty-response.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-https-proxy-request-proxy-failure-500.mjs
```
