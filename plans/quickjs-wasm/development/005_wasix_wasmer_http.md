# Edge QuickJS WASIX Wasmer run enablement

## Context

The goal for this phase was to make the QuickJS-backed Edge WASIX build work
under Wasmer, including both the default package entrypoint and running a JS
script through the package:

```sh
wasmer run .
wasmer run --volume ./:/app . -- /app/echo-server.js
```

The desired end state was not just "the binary starts"; the HTTP echo server
also needed to accept a connection, dispatch the request into JS, and return a
response.

## Build shape

The relevant local Edge build output is:

```text
~/src/edgejs/build-quickjs-wasix/edge
```

For local package testing, the built executable is also copied to the package
names Wasmer expects:

```text
~/src/edgejs/build-quickjs-wasix/edge.wasm
~/src/edgejs/build-quickjs-wasix/edgejs.wasm
```

The direct build commands used during debugging were:

```sh
cmake --build build-quickjs-wasix --target edge -j4
cmake --build build-edge-quickjs-cli --target edge -j4
```

The Makefile now has helper targets for these:

```sh
make build-quickjs-wasix-edge JOBS=4
make build-edge-quickjs-cli-edge JOBS=4
make build-quickjs-edge-targets JOBS=4
make clean-quickjs-wasix
make clean-edge-quickjs-cli
make clean-quickjs-edge-targets
make test-only-quickjs
```

## Wasmer compatibility notes

The Wasmer binary that worked for local testing was built from
`~/src/wasmer` with the CLI features that allow artifact loading
and LLVM execution:

```sh
cargo build --release \
  --manifest-path lib/cli/Cargo.toml \
  --features llvm,napi-v8,wasmer-artifact-create,static-artifact-create,wasmer-artifact-load,static-artifact-load \
  --bin wasmer \
  --locked
```

Earlier, a Wasmer invocation failed with:

```text
compile error: Validate("exception refs not supported without the exception handling feature ...")
```

That was a Wasmer/runtime feature mismatch for this WASIX artifact. Running with
a compatible locally-built Wasmer, and during investigation using:

```sh
--llvm --enable-exceptions --disable-cache
```

got us past validation. Later, after the artifact and runtime path were in a
good state, the simpler package commands worked too:

```sh
wasmer run .
wasmer run --volume ./:/app . -- /app/echo-server.js
```

For network tests, Wasmer needs networking enabled:

```sh
wasmer run --net --volume ./:/app . -- /app/echo-server.js
```

## Bootstrap failure: Atomics under WASIX

After temporarily getting past the QuickJS teardown assertion so that startup
errors were visible, Wasmer reported:

```text
Failed to execute internal/per_context/primordials: undefinedError
    at ownKeys (native)
    at copyPropsRenamed (<input>:78:36)
```

The failure happened very early in Node bootstrap, while executing
`internal/per_context/primordials`.

The underlying problem was that QuickJS's Atomics/thread support was disabled
for all `__wasi__` builds. Edge's Node bootstrap expects `Atomics` and
`SharedArrayBuffer` to exist for this WASIX target when wasm atomics are
available.

We changed the QuickJS guards so WASIX can use atomics when
`__wasm_atomics__` is defined:

```text
~/src/edgejs/quickjs/quickjs.c
~/src/edgejs/quickjs/cutils.h
```

The important condition became:

```c
(!defined(__wasi__) || defined(__wasm_atomics__))
```

instead of excluding `__wasi__` unconditionally.

After that, this WASIX check succeeded:

```sh
wasmer run . -- -e "console.log(typeof Atomics, typeof SharedArrayBuffer)"
```

Expected output:

```text
object function
```

That fixed the bootstrap failure in `internal/per_context/primordials`.

## HTTP server hang

Once bootstrap worked, the echo server could start:

```text
quickjs edge echo listening on 3000
```

But `curl http://127.0.0.1:3000/` connected and then hung. Adding:

```js
console.log(`quickjs edge echo: ${req.method} ${req.url}`)
```

inside `echo-server.js` showed that the HTTP request callback fired in the
native QuickJS CLI but did not fire in the WASIX run.

We added gated network tracing with `EDGE_TRACE_NET=1` across:

```text
~/src/edgejs/src/edge_tcp_wrap.cc
~/src/edgejs/src/edge_stream_base.cc
~/src/edgejs/src/edge_stream_listener.cc
~/src/edgejs/src/edge_http_parser.cc
~/src/edgejs/lib/_http_server.js
~/src/edgejs/lib/internal/stream_base_commons.js
```

The trace showed that libuv networking was working:

```text
tcp bind6 ... rc=0(OK)
tcp listen ... rc=0(OK)
tcp onconnection ... status=0(OK)
tcp accept ... rc=0(OK)
tcp read_start ... rc=0(OK)
stream read ... nread=77
```

But the request bytes were delivered to the wrong stream listener. The key
trace shape was:

```text
http_parser consume ... stream=0x...dd0
stream uv_read base=0x...dd8 ...
stream missing_onread ...
```

The parser listener was attached at `0x...dd0`, while libuv reads arrived on
`0x...dd8`.

## Root cause of the stream pointer mismatch

`TcpWrap` is laid out with the N-API env first and the stream base second:

```cpp
struct TcpWrap {
  napi_env env = nullptr;
  EdgeStreamBase base{};
  uv_tcp_t handle{};
  int socket_type = kTcpSocket;
};
```

So:

```text
0x...dd0 == TcpWrap*
0x...dd8 == &TcpWrap::base
```

`parser.consume(socket._handle)` calls `EdgeStreamBaseFromValue(...)`.

On QuickJS, `socket._handle` was reported as `napi_external`, because our
QuickJS N-API constructor path creates class instances with the same QuickJS
class id used for N-API externals. The conversion code therefore treated the
wrapped `TCP` object as a raw external pointer and returned the wrapper address
instead of unwrapping it and returning `&wrap->base`.

That attached the HTTP parser listener to the wrong `EdgeStreamBase`. The real
libuv read path continued using the correct `&wrap->base`, so the parser never
saw the request bytes.

## Stream fix

We added wrapper-specific stream-base accessors and made the generic stream
conversion prefer them before falling back to raw external data:

```text
~/src/edgejs/src/edge_tcp_wrap.h
~/src/edgejs/src/edge_tcp_wrap.cc
~/src/edgejs/src/edge_pipe_wrap.h
~/src/edgejs/src/edge_pipe_wrap.cc
~/src/edgejs/src/edge_tty_wrap.h
~/src/edgejs/src/edge_tty_wrap.cc
~/src/edgejs/src/edge_stream_base.cc
```

The TCP/Pipe/TTY helpers now:

1. Accept `napi_object`, `napi_function`, and QuickJS's current
   `napi_external`-reported class instances.
2. Call `napi_unwrap(...)`.
3. Validate the native wrapper by checking `handle->data == wrap`.
4. Validate the libuv handle type, for example `UV_TCP` for TCP.
5. Return `&wrap->base`.

After the fix, the trace changed to the correct shape:

```text
tcp get_stream_base unwrap_status=0 wrap=0x...dd0
tcp get_stream_base base=0x...dd8 handle=0x...e70 data=0x...dd0 type=12 expected=12
stream from_value tcp base=0x...dd8
http_parser consume ... stream=0x...dd8
stream uv_read base=0x...dd8 current=<http parser listener>
http_parser consumed_read ... nread=77
js http_server parserOnIncoming method= GET url= /
quickjs edge echo: GET /
```

`curl` then received a normal response:

```text
HTTP/1.1 200 OK
content-type: text/plain

quickjs edge echo: GET /
```

## Verification

The traced verification command used during debugging was:

```sh
~/src/wasmer/target/release/wasmer run \
  --llvm --enable-exceptions --disable-cache --net \
  --env EDGE_TRACE_NET=1 \
  --env PORT=3003 \
  --volume ~/src/edgejs/quickjs-wasm:/app \
  . -- /app/echo-server.js
```

Then:

```sh
curl -v --max-time 8 http://127.0.0.1:3003/
```

This returned:

```text
quickjs edge echo: GET /
```

The clean non-traced run also worked and stayed alive after the keep-alive close
window.

The final user-confirmed commands also work:

```sh
wasmer run --volume ./:/app . -- /app/echo-server.js
wasmer run .
```

## Current status

The QuickJS Edge WASIX package can now bootstrap under Wasmer and run the echo
server path correctly.

The important implementation lessons are:

1. WASIX QuickJS needs Atomics enabled when the target has wasm atomics.
2. QuickJS N-API class instances may currently appear as `napi_external`, so
   code that accepts both wrapper objects and raw externals must try
   `napi_unwrap(...)` first when a known wrapper type is possible.
3. The HTTP parser consume path depends on the listener being attached to the
   exact `EdgeStreamBase` used by the libuv read callbacks.
4. Embedded QuickJS WASIX targets that include N-API headers must compile with
   the embedded-provider declaration mode (`NAPI_EXTERN=`). If one static
   library sees default `__wasm__` N-API imports from module `napi` while
   another sees the same unresolved calls through `env`, the final `wasm-ld`
   link fails with an import module mismatch. The concrete fixed case was
   `edge_environment_core`.

Longer term, it may be cleaner for the QuickJS N-API implementation to avoid
representing constructed N-API class instances with the same QuickJS class id as
plain `napi_external` values. The stream wrapper fix is intentionally narrow and
validated, but the type-reporting behavior is still worth revisiting.
