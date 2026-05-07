# Node Test: QuickJS compatibility failures

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Active issue index for `test-only.log` failures from the native QuickJS Edge CLI. |
| **Severity** | High | The current node compatibility run has 60 failed paths across core modules. |

Source log:

```text
/Users/sadhbh/src/dev/edgejs/test-only.log
```

Command captured by the log:

```sh
NODE_TEST_RUNNER=build-edge-quickjs-cli/edge ./test/nodejs_test_harness --category=node:buffer,node:console,node:dgram,node:diagnostics_channel,node:dns,node:events,node:http,node:https,node:os,node:path,node:punycode,node:querystring,node:stream,node:string_decoder,node:tty,node:url,node:zlib,node:crypto,node:domain,node:http2,node:tls,node:sys \
  --skip-tests=known_issues/test-stdin-is-always-net.socket.js,parallel/test-dns-perf_hooks.js,parallel/test-dns-channel-timeout.js
```

The failures cluster into compatibility surfaces rather than 60 independent
bugs. Work these in targeted groups and rerun the representative tests before
rerunning the whole `make test-only BUILD_DIR=build-edge-quickjs-cli` path.

## Issues

### ▶️ [001_buffer_limits_and_deprecations.md](001_buffer_limits_and_deprecations.md): Buffer limits and deprecation parity

Why: Buffer allocation and string-size tests expose QuickJS typed-array limit
messages, missing invalid-string-length checks, and Node module deprecation
classification differences.

### ▶️ [002_console_inspect_and_stack_formatting.md](002_console_inspect_and_stack_formatting.md): console inspect and stack formatting

Why: console inspection fails on revoked proxies, Map table rows are omitted,
and pseudo-TTY stack formatting uses QuickJS `<input>` frames instead of
Node-style filenames.

### ▶️ [003_node_test_public_api_exports.md](003_node_test_public_api_exports.md): `node:test` public API exports

Why: ESM tests importing `describe` from `node:test` fail during module linking.

### ▶️ [004_diagnostics_channel_module_loader.md](004_diagnostics_channel_module_loader.md): diagnostics channel module loader events

Why: ESM module import diagnostics are not published for successful or failed
module loading.

### ▶️ [005_diagnostics_channel_async_context.md](005_diagnostics_channel_async_context.md): diagnostics channel async context

Why: tracing-channel validation messages differ, async context is lost across
promises, and a worker-thread diagnostics test times out.

### ▶️ [006_eventemitter_asyncresource_private_fields.md](006_eventemitter_asyncresource_private_fields.md): EventEmitterAsyncResource private-field errors

Why: QuickJS private-field TypeError wording does not match the Node/V8
expectation used by `assert.throws()`.

### ▶️ [007_fetch_response_body_and_proxy_env.md](007_fetch_response_body_and_proxy_env.md): fetch Response body and HTTP proxy env

Why: `fetch()` can produce an undefined response/body path, causing `.text()`
to throw and HTTP proxy environment fixtures to exit with code 1.

### ▶️ [008_https_proxy_tunnel_errors.md](008_https_proxy_tunnel_errors.md): HTTPS proxy tunnel errors

Why: HTTPS-over-proxy tests either attempt TLS against the proxy connection or
surface `ERR_PROXY_TUNNEL` without the expected diagnostic message/body.

### ▶️ [009_http_timers_and_header_limits.md](009_http_timers_and_header_limits.md): HTTP timers and header limits

Why: HTTP timeout warnings, max-header-size test-runner behavior, and some proxy
edge cases do not match Node.

### ▶️ [010_os_constants_and_userinfo.md](010_os_constants_and_userinfo.md): OS constants and userInfo errors

Why: OS constants immutability and `os.userInfo()` getter-error handling produce
different observable errors from Node.

### ▶️ [011_fastutf8stream_sync_wait.md](011_fastutf8stream_sync_wait.md): FastUtf8Stream synchronous wait

Why: synchronous UTF-8 stream operations call an Atomics wait path that QuickJS
reports as `cannot block in this thread`.

### ▶️ [012_explicit_resource_management_syntax.md](012_explicit_resource_management_syntax.md): explicit resource management syntax

Why: stream destroy/dispose tests using `using` / `await using` syntax fail at
QuickJS parse time.

### ▶️ [013_stream_missing_builtins_and_async_iterators.md](013_stream_missing_builtins_and_async_iterators.md): stream missing builtins and async iterators

Why: stream tests expose missing builtin modules and a readable async-iterator
behavior mismatch.

### ▶️ [014_string_decoder_utf8_boundaries.md](014_string_decoder_utf8_boundaries.md): StringDecoder UTF-8 boundaries

Why: incomplete or invalid UTF-8 sequences produce two replacement characters
where Node expects one.

### ▶️ [015_url_and_data_url_validation.md](015_url_and_data_url_validation.md): URL and data URL validation

Why: URL/data URL tests report `ERR_INVALID_ARG_VALUE` in places where Node
expects successful parsing or a more specific validation result.

### ▶️ [016_whatwg_url_inspect_and_searchparams.md](016_whatwg_url_inspect_and_searchparams.md): WHATWG URL inspect and search params

Why: URL custom inspect output, lone surrogate encoding, and
`URLSearchParams` symbol-conversion TypeError messages differ from Node.
