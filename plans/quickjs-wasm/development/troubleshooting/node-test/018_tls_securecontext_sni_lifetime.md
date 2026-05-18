# Node Test: TLS SecureContext, SNI, and setKeyCert lifetime

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed with QuickJS N-API own-wrap lookup and native TLS SecureContext retention. |
| **Severity** | High | Remaining TLS failures included one assertion failure and one native crash. |

## Current Reproduction

After the QuickJS N-API object/external classification fix, the old broad
TLS/SNI cluster is much smaller. The current focused SNI/SecureContext sample
shows these QuickJS results:

```text
test/parallel/test-tls-add-context.js                              pass
test/parallel/test-tls-empty-sni-context.js                        pass
test/parallel/test-tls-sni-option.js                               pass
test/parallel/test-tls-sni-servername.js                           pass
test/parallel/test-tls-sni-server-client.js                        pass
test/parallel/test-tls-snicallback-error.js                        pass
test/parallel/test-tls-socket-snicallback-without-server.js        pass
test/parallel/test-tls-connect-secure-context.js                   pass
test/parallel/test-tls-secure-context-usage-order.js               pass
test/parallel/test-tls-set-secure-context.js                       pass
test/parallel/test-tls-server-setkeycert.js                        crash
```

The full TLS category run:

```sh
NODE_TEST_RUNNER=build-edge-quickjs-cli/edge ./test/nodejs_test_harness --category=node:tls
```

reported two failures before the fix:

```text
test/parallel/test-tls-external-accessor.js
test/parallel/test-tls-server-setkeycert.js
```

The same focused checks pass under `build-edge/edge`.

## Root Cause: inherited wrap metadata

`test-tls-external-accessor.js` creates an object whose prototype is a real
`SecureContext` native wrapper:

```js
const pctx = tls.createSecureContext().context;
const cctx = { __proto__: pctx };
assert.throws(() => cctx._external, TypeError);
```

V8 `napi_unwrap(...)` only succeeds for the exact object that was wrapped.
QuickJS currently lets `napi_external__::get_wrap_record(...)` read
`__napi_wrap__` through `JS_GetPropertyStr(...)`, which walks the prototype
chain. That makes `napi_unwrap(env, cctx, ...)` incorrectly unwrap `pctx`.

This is a QuickJS N-API semantics bug, not a TLS-specific behavior. The fix is
to make wrap-record lookup own-property-only after checking the object's direct
opaque slot.

## Root Cause: switched SecureContext lifetime

`test-tls-server-setkeycert.js` calls `this.setKeyCert(altKeyCertVal)` from
`ALPNCallback`. When `altKeyCertVal` is a plain key/cert options object,
unchanged `lib/internal/tls/wrap.js` creates a temporary `SecureContext` inside
`TLSSocket.prototype.setKeyCert(...)` and passes only
`secureContext.context` to native code.

Native `TlsWrapSetKeyCert(...)` extracts the `SecureContextHolder*` and calls
`SetSecureContextOnSsl(...)`, which switches OpenSSL to the new `SSL_CTX` and
stores:

```cpp
wrap->secure_context = holder;
```

but it does not retain a `napi_ref` to the JavaScript `SecureContext.context`
object. QuickJS releases callback-local values promptly, so the temporary
native `SecureContext` can be finalized while the `SSL*` is still using the
new `SSL_CTX` and its `SSL_CTX_get_app_data(...)` pointer.

LLDB shows the crash later in the session-ticket callback:

```text
_platform_memset
drbg_ctr_generate
ossl_prov_drbg_generate
EVP_RAND_generate
edge::crypto::TicketCompatibilityCallback(...)
tls_construct_new_session_ticket
SSL_read
ReadCleartext
ParentStreamOnRead
```

The important detail is that `TicketCompatibilityCallback(...)` recovers the
holder from `SSL_CTX_get_app_data(SSL_get_SSL_CTX(ssl))`. If the holder was
deleted after the temporary JS `SecureContext` finalized, the callback reads a
freed `std::vector<unsigned char>` for ticket keys.

V8 passes because its lifetime/GC timing keeps the temporary wrapper alive long
enough in this test. That is not an ownership guarantee and should not be
relied on.

## Fix

1. QuickJS N-API unwrap semantics:
   - `napi_external__::get_wrap_record(...)` now reads `__napi_wrap__` only as
     an own property with `JS_GetOwnProperty(...)`.
   - The direct opaque-record path is unchanged.
   - No EdgeJS-local N-API regression test is added for this; that coverage
     belongs in the N-API repo.

2. TLS context ownership on native context switches:
   - `src/edge_tls_wrap.cc` now replaces
     `wrap->context_ref` with a strong reference to the selected
     `SecureContext.context` object only after `SetSecureContextOnSsl(...)`
     succeeds.
   - `TlsWrapSetKeyCert(...)` uses the retaining switch helper.
   - The SNI `TlsWrapCertCbDone(...)` path uses the same ownership update
     when a selected SNI context is installed.
   - The initial `TlsWrapWrap(...)` reference behavior is unchanged.

3. Defensive cleanup around `SecureContextHolder`:
   - Before freeing a holder-owned `SSL_CTX`, native code clears `SSL_CTX`
     app-data and the ticket callback.
   - This guards future forgotten ownership paths; the primary fix remains the
     strong `napi_ref` from active `TlsWrap` to selected context.

No `lib/` file was changed. The JavaScript lifetime shape is Node's contract;
native now retains what OpenSSL continues to use.

## Verification

Rebuild:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
cmake --build build-edge --target edge -j4
```

Targeted checks:

```sh
build-edge-quickjs-cli/edge test/parallel/test-tls-external-accessor.js
build-edge-quickjs-cli/edge test/parallel/test-tls-server-setkeycert.js
build-edge-quickjs-cli/edge test/parallel/test-tls-add-context.js
build-edge-quickjs-cli/edge test/parallel/test-tls-sni-option.js
build-edge-quickjs-cli/edge test/parallel/test-tls-sni-servername.js
build-edge-quickjs-cli/edge test/parallel/test-tls-sni-server-client.js
build-edge-quickjs-cli/edge test/parallel/test-tls-snicallback-error.js
build-edge-quickjs-cli/edge test/parallel/test-tls-socket-snicallback-without-server.js
build-edge-quickjs-cli/edge test/parallel/test-tls-connect-secure-context.js
build-edge-quickjs-cli/edge test/parallel/test-tls-secure-context-usage-order.js
build-edge-quickjs-cli/edge test/parallel/test-tls-set-secure-context.js
```

These targeted checks passed. The broader TLS category also passed:

```sh
NODE_TEST_RUNNER=build-edge-quickjs-cli/edge ./test/nodejs_test_harness --category=node:tls
```

Result:

```text
195/195 passed
```

V8 regression checks:

```sh
build-edge/edge test/parallel/test-tls-external-accessor.js
build-edge/edge test/parallel/test-tls-server-setkeycert.js
build-edge/edge test/parallel/test-tls-add-context.js
```

These passed after rebuilding `build-edge/edge`.
