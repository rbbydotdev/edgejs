# V8 Node Test Investigation

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Active V8 Linux node-test follow-up after the V8 N-API/contextify fixes. |
| **Severity** | High | Blocks the `v8-linux` GitHub Actions test lane. |

## Scope

This note is the home for V8-backed EdgeJS node-test findings. QuickJS
compatibility notes should only mention V8 as comparison data; V8 CI failures,
Docker reproductions, and V8 N-API follow-ups belong here.

## Current Baseline

Before the May 16, 2026 Linux Docker rerun below, the local V8 runtime-test
baseline had been:

```text
V8: make test-only -> 1757/1757 passed
```

That baseline does not represent the current Linux amd64 CI result after the
newer GitHub failure log; use the Docker result below for the active `v8-linux`
state.

## CI Lanes

V8 build lanes:

| Target OS | Workflow job | Command |
| --- | --- | --- |
| Linux | `v8-linux` | `make build` |
| macOS | `v8-macos` | `make build` |
| WASIX | `v8-wasix` | `make build-wasix` |

V8 runtime test lanes:

| Host OS | Workflow job | Command |
| --- | --- | --- |
| Linux | `v8-linux` | `make test-only` |
| macOS | `v8-macos` | `make test-only` |

V8 publish lane:

| Workflow job | Gate | Publishes |
| --- | --- | --- |
| `publish-nightly` | `push` to `main` after `metadata`, `v8-linux`, `v8-macos`, and `v8-wasix` pass | `edge-linux-amd64`, `edge-darwin-arm64`, `edge-wasix`, and the V8 WASIX package |

## May 16, 2026 Linux Docker Result

The May 16, 2026 `v8-linux` GitHub Actions log originally reported 20 failing
tests. Reproducing the lane inside Linux amd64 Docker from macOS, with the
build directory outside the bind mount at `/tmp/build-edge-v8`, reduced the
current failure set to 7 tests:

```text
test/parallel/test-dns-channel-timeout.js
test/parallel/test-http-server-headers-timeout-keepalive.js
test/parallel/test-http-server-request-timeout-keepalive.js
test/parallel/test-domain-abort-on-uncaught.js
test/parallel/test-http2-client-jsstream-destroy.js
test/parallel/test-http2-compat-serverresponse-write.js
test/parallel/test-tls-connect-abort-controller.js
```

The reproduced suite completed with 1772 passing tests and 7 failures.

## Reproduction

The Docker container used `linux/amd64` and an `ubuntu:latest`-derived build
state. Source was mounted from the host at `/workspace`; the CMake build
directory was `/tmp/build-edge-v8` in container-local storage.

```sh
NAPI_V8_BUILD_METHOD=prebuilt CC=clang CXX=clang++ cmake --build /tmp/build-edge-v8 --target edge -j2
NAPI_V8_BUILD_METHOD=prebuilt CC=clang CXX=clang++ make test-only BUILD_DIR=/tmp/build-edge-v8 TEST_JOBS=4
```

Rerunning the seven failing tests one at a time showed that five are not stable
single-test failures:

```text
test/parallel/test-dns-channel-timeout.js                         pass
test/parallel/test-http-server-headers-timeout-keepalive.js       pass
test/parallel/test-http-server-request-timeout-keepalive.js       pass
test/parallel/test-domain-abort-on-uncaught.js                    pass
test/parallel/test-http2-compat-serverresponse-write.js           pass
```

`test-domain-abort-on-uncaught.js` prints three
`Failed to execute builtin 'internal/main/run_main_module':` lines during the
single-test run but exits 0. Treat the suite timeout as load/order-sensitive
until an isolated repro is found.

Two failures reproduce consistently in isolation:

```text
test/parallel/test-http2-client-jsstream-destroy.js
test/parallel/test-tls-connect-abort-controller.js
```

## Stable Failure: JSStream Destroyed Write

`test-http2-client-jsstream-destroy.js` fails with an unhandled
`ERR_STREAM_DESTROYED`:

```text
Error [ERR_STREAM_DESTROYED]: Cannot call write after a stream was destroyed
    at JSSocket._write (.../test-http2-client-jsstream-destroy.js:25:17)
    at JSStreamSocket.doWrite (node:internal/js_stream_socket:200:17)
    at JSStream.onwrite (node:internal/js_stream_socket:35:57)
    at process.processImmediate (node:internal/timers:504:21)
```

`src/edge_js_stream.cc` already tries to translate a pending
`ERR_STREAM_DESTROYED` from `JSStream.onwrite` into `UV_EPIPE`. This fixed the
macOS V8 targeted run, but the same test still fails reproducibly in the Linux
amd64 Docker `v8-linux` reproduction.

A native-only follow-up that also matched the exception message did not change
the Linux result, so the error is not available to `CallOnWrite(...)` as a
normal pending N-API exception by the time that helper returns.

The next investigation should compare Node's `internal/js_stream_socket`
ordering around `kCurrentWriteRequest`: this checkout sets the current write
request only after `stream.write(...)` and `stream.uncork()`, so a synchronous
destroyed-write throw can escape before the wrapper has a request to complete.
Sadhbh prefers not to change `lib/`; if possible, fix this by changing the
native callback/fatal-exception path so this specific JSStream write failure is
converted to a write completion instead of a top-level fatal exception.

Earlier macOS verification for the native pending-exception conversion:

```sh
cmake --build build-edge --target edge -j4
build-edge/edge test/parallel/test-http2-client-jsstream-destroy.js
```

The HTTP/2 test binds a local socket, so sandboxed local runs may need to be
rerun outside the filesystem sandbox when they fail with `listen EPERM`.

## Stable Failure: TLS Abort-Controller Late Connect

`test-tls-connect-abort-controller.js` fails with:

```text
TypeError: Cannot set properties of null (setting 'reading')
    at TCP.set [as reading] (node:internal/tls/wrap:770:28)
    at tryReadStart (node:net:714:30)
    at Socket._read (node:net:731:5)
    at TLSSocket.<anonymous> (node:net:729:37)
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1622:10)
```

With `NODE_DEBUG=net,tls`, the failing sequence shows abort/close activity
before a later `afterConnect` path emits `connect`, calls TLS `_start`, then
`read(0)` reaches the TLS handle-reading accessor after
`onSocketCloseDestroySSL()` has set `socket[kRes] = null`.

A native-only attempt to convert successful TCP connect completions to
`UV_ECANCELED` when the `TcpWrap` handle was closing did not change the result.
That means the relevant parent TCP wrapper is not marked closing at the point
`OnConnectDone(...)` invokes `req.oncomplete`, or the destroyed state that
matters lives on the owning `TLSSocket` rather than the raw handle.

The next native-first path was initially thought to be inspecting the owner
stored on the TCP handle via `owner_symbol` before invoking `afterConnect`.
That turned out to be the wrong layer after comparing Node's implementation:
Node's native `ConnectionWrap::AfterConnect()` does not inspect JS owner state,
TLS state, or stream properties. It reports libuv's connect status and
readable/writable flags, and `lib/net.js` decides whether to ignore late
callbacks via `if (self.destroyed) return`.

## 2026-05-17 Native Follow-up

The stable Linux/V8 fixes were kept native-only:

- `src/edge_js_stream.cc` activates JSStream write/shutdown requests before
  entering JS. If `onwrite` throws `ERR_STREAM_DESTROYED`, native now has an
  active request to complete/mark done instead of letting the exception escape
  as a top-level fatal exception.
- `src/internal_binding/binding_http2.cc` schedules session output through the
  native immediate queue, but stream destroy remains on JS `setImmediate` to
  match Node's HTTP/2 stream teardown shape.
- HTTP/2 parent socket writes now mirror Node's
  `Http2Session::ClearOutgoing()` behavior: stream writes already serialized by
  nghttp2 complete with status `0`; parent socket errors are used for session
  bookkeeping, not exposed as user stream write errors.
- No-error or `NGHTTP2_CANCEL` deferred HTTP/2 stream teardown completes
  remaining queued stream writes with status `0`; other reset/error codes still
  complete with `UV_ECANCELED`.
- `src/edge_tcp_wrap.cc` now mirrors Node's TCP connect callback shape: it
  passes libuv's status through unchanged and computes the readable/writable
  booleans with `uv_is_readable()` / `uv_is_writable()` only for successful
  connects. It does not inspect `owner_symbol` or TLS JS state.

QuickJS regressions caused by the first native pass:

```text
test/parallel/test-http2-close-while-writing.js
test/parallel/test-http2-create-client-connect.js
test/parallel/test-tls-close-notify.js
```

Root causes:

- a broad HTTP/2 parent `isClosing()` preflight converted normal close races
  into queued stream write cancellations; it was removed;
- TLS and HTTP/2 were forwarding internal parent-write `UV_ECANCELED` statuses
  to JS-visible write completions, unlike Node's hidden parent write path;
- `test-http2-create-client-connect.js` exposed teardown GC where
  `TlsWrapFinalize()` notified HTTP/2 stream listeners after environment
  cleanup had already started.

Additional native hardening:

- `EdgeStreamNotifyClosed()` now saves `next` before invoking listener
  `on_close` callbacks, so callbacks can remove/mutate listeners safely.
- `TlsWrapFinalize()` skips JS-facing close notification once
  `Environment::cleanup_started()` is true; normal close paths still notify.
- A short-lived TCP owner-state heuristic was removed. It tried to convert
  late TLS abort completions to `UV_ECANCELED` by reading JS properties such as
  `encrypted`, `readable`, and `connecting`, but Node never does this and it
  caused QuickJS HTTP/2/TLS regressions.

Verification after the follow-up:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
python3 test/tools/test.py --timeout 30 --test-root ./test \
  --shell ./build-edge-quickjs-cli/edge -j 1 \
  parallel/test-http2-close-while-writing \
  parallel/test-http2-create-client-connect \
  parallel/test-tls-close-notify

cmake --build build-edge --target edge -j4
python3 test/tools/test.py --timeout 30 --test-root ./test \
  --shell ./build-edge/edge -j 1 \
  parallel/test-http2-client-jsstream-destroy \
  parallel/test-tls-connect-abort-controller \
  parallel/test-http2-close-while-writing \
  parallel/test-http2-create-client-connect \
  parallel/test-tls-close-notify

python3 test/tools/test.py --timeout 30 --test-root ./test \
  --shell ./build-edge/edge -j 1 \
  parallel/test-dns-channel-timeout \
  parallel/test-http-server-headers-timeout-keepalive \
  parallel/test-http-server-request-timeout-keepalive \
  parallel/test-http2-client-jsstream-destroy \
  parallel/test-tls-connect-abort-controller

make test-quickjs-only TEST_JOBS=4
```

The final QuickJS full-suite result after removing the TCP owner-state
heuristic returned to the previous baseline:

```text
[06:49|% 100|+ 1757|-  17]: Done
```

## Load-Sensitive Failures

The DNS, HTTP timer, domain, and HTTP/2 response-write failures passed as
single tests after the full suite reported them. For now they should be treated
as load-sensitive symptoms:

- `test-dns-channel-timeout.js`: likely resolver timeout scheduling under
  concurrent test load.
- `test-http-server-headers-timeout-keepalive.js` and
  `test-http-server-request-timeout-keepalive.js`: likely timer delay under
  amd64 emulation or suite concurrency.
- `test-domain-abort-on-uncaught.js`: child-process/domain timing; the warning
  lines persist but the test exits 0 in isolation.
- `test-http2-compat-serverresponse-write.js`: crashed in the suite but passed
  alone, so rerun under LLDB only after finding a focused reproducer.

## Rejected Native Attempts

Two narrow source attempts were tried and reverted because they did not improve
the stable Linux failures:

- expanding `src/edge_js_stream.cc` destroyed-write matching from
  `exception.code === "ERR_STREAM_DESTROYED"` to also match the exception
  message;
- changing `src/edge_tcp_wrap.cc::OnConnectDone(...)` to report
  `UV_ECANCELED` for status-0 connect completions when the `TcpWrap` base or
  libuv handle was already closing.

Keep these as negative evidence: the stable failures require a better model of
callback ownership/state, not just a broader error string match or raw-handle
closing check.
