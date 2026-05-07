# Node Test: fetch Response body and HTTP proxy env

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | High | Breaks global `fetch()` and HTTP proxy environment tests. |

Affected tests:

- `client-proxy/test-http-proxy-fetch`
- `client-proxy/test-use-env-proxy-cli-http`
- `parallel/test-fetch`

## What Is The Issue

The HTTP proxy fetch fixtures fail with:

```text
TypeError: cannot read property 'text' of undefined
```

The fixture calls `await fetch(...).then((res) => res.text())`, so the failure
means the fulfilled value is `undefined` or the response body bridge is
incorrectly detached. `parallel/test-fetch` also fails an assertion at the early
fetch smoke check.

The HTTP proxy environment test shows that plain HTTP proxying reaches the
server and can print status/header information, but the child fixture still
exits with code 1 because the `fetch()` response path is broken.

## How Should We Fix It

Start with a minimal native QuickJS CLI repro:

```sh
build-edge-quickjs-cli/edge -e "fetch('http://127.0.0.1:<port>').then(async r => console.log(r && r.constructor.name, await r.text()))"
```

Then inspect the JS fetch implementation and the native HTTP/client bridge:

- ensure the promise resolves to a real `Response` instance;
- ensure `Response.prototype.text()` is installed and bound to the response body;
- verify that proxy environment handling does not replace the fetch result with
  an internal completion value;
- rerun with `EDGE_TRACE_NET=1` if the body stream is present but not delivered.

Do not special-case the tests. Fix the global `fetch()` response construction so
plain fetch, HTTP proxy fetch, and environment proxy fetch share the same path.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-fetch.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-http-proxy-fetch.mjs
build-edge-quickjs-cli/edge test/client-proxy/test-use-env-proxy-cli-http.mjs
```
