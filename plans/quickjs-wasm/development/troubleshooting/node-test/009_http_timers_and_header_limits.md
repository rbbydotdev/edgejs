# Node Test: HTTP timers and header limits

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Medium | Affects HTTP edge-case tests around timers, warnings, and CLI option propagation. |

Affected tests:

- `parallel/test-http-keep-alive-timeout-race-condition`
- `client-proxy/test-http-proxy-request-invalid-char-in-url`
- `parallel/test-http-timeout-client-warning`
- `parallel/test-set-http-max-http-headers`

## What Is The Issue

The log shows a mix of HTTP timing and validation failures:

- `test-http-timeout-client-warning` emits a `TimeoutOverflowWarning`, but the
  warning object does not satisfy the test assertion.
- `test-set-http-max-http-headers` reports `ERR_INVALID_ARG_VALUE` through the
  test runner instead of completing its child-process checks.
- The keep-alive timeout race and invalid-character proxy request tests do not
  complete normally in the log.

These failures likely share event-loop/timer and option propagation surfaces
rather than parser bugs alone.

## How Should We Fix It

Investigate in this order:

1. Reproduce `test-http-timeout-client-warning` alone and inspect the emitted
   warning object's `name`, `code`, message, and stack. Normalize timer overflow
   warning construction to Node's shape.
2. Reproduce `test-set-http-max-http-headers` with child process stdio captured.
   Verify `--max-http-header-size` and `NODE_OPTIONS` propagation through
   `src/edge_cli.cc` into the HTTP parser configuration.
3. Reproduce the timeout/hang cases with `EDGE_TRACE_NET=1` and timer tracing.
   Confirm server close, socket timeout, keep-alive cleanup, and proxy request
   rejection all schedule and drain their callbacks.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-http-timeout-client-warning.js
build-edge-quickjs-cli/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-set-http-max-http-headers.js
build-edge-quickjs-cli/edge test/parallel/test-http-keep-alive-timeout-race-condition.js
build-edge-quickjs-cli/edge test/client-proxy/test-http-proxy-request-invalid-char-in-url.mjs
```
