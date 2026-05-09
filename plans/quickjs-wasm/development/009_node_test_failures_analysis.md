# Node compatibility test failure analysis

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Historical failure clustering; individual failures have node-test issue pages. |
| **Severity** | High | Node compatibility failures remain significant until the linked issue pages close. |

Date: 2026-05-07

Command under investigation:

```sh
make test-only TEST_JOBS=4
NODE_TEST_RUNNER=build-edge/edge ./test/nodejs_test_harness --category=node:buffer,node:console,node:dgram,node:diagnostics_channel,node:dns,node:events,node:http,node:https,node:os,node:path,node:punycode,node:querystring,node:stream,node:string_decoder,node:tty,node:url,node:zlib,node:crypto,node:domain,node:http2,node:tls,node:sys \
  --skip-tests=known_issues/test-stdin-is-always-net.socket.js,parallel/test-dns-perf_hooks.js,parallel/test-dns-channel-timeout.js
```

The pasted CI run ends with 92 failures out of 1685 tests. A local rerun from
this workspace also exits with code 2, but the local failure count is larger
because the current workspace build/environment exposes the same broken surfaces
across more tests. The root-cause grouping below is based on the pasted CI
signatures and source inspection.

## Summary

Most failures are not independent subsystem regressions. They cluster around a
small number of incomplete Node compatibility surfaces:

1. `require('v8')` can crash during module evaluation because
   `internalBinding('config').hasInspector` is advertised as true while the
   `profiler` internal binding is not implemented.
2. The global `console` does not write through to stdio in normal `console.*`
   calls, which also breaks proxy fixtures that log status/body with
   `console.log()`.
3. The CLI `-p` / `--print` path evaluates code but does not print expression
   results.
4. JS-transferable structured clone support loses `File` identity and returns a
   plain object.
5. Some flags are accepted or exposed even though the backing feature is missing
   or incomplete: inspector, CPU/heap profiling, HTTP/HTTP2 debug warning
   shape, and string-decoder maximum string checks.

## Root Cause 1: `node:v8` Profiler Crash

Representative failures:

- `test-dgram-async-dispose`
- `test-dgram-*-cluster-*`
- `test-diagnostics-channel-process`
- `test-events-add-abort-listener`
- `test-http-server-drop-connections-in-cluster`
- `test-domain-top-level-error-handler-throw`
- `test-domain-uncaught-exception`
- `test-http2-ping-settings-heapdump`
- several TLS tests using `node:test`, `child_process.fork()`, or coverage/test
  runner helpers

Observed signature:

```text
node:v8:508
  takeCoverage: profiler.takeCoverage,
                       ^
TypeError: Cannot read properties of undefined (reading 'takeCoverage')
```

Why it happens:

- `lib/v8.js` initializes `profiler` from `internalBinding('profiler')` whenever
  `internalBinding('config').hasInspector` is true.
- `src/internal_binding/binding_config.cc` currently hard-codes
  `hasInspector = true`.
- `src/internal_binding/dispatch.cc` has no `profiler` resolver, so unresolved
  bindings return undefined.
- `lib/v8.js` then exports `takeCoverage: profiler.takeCoverage`, which throws
  if `profiler` is undefined.

Relevant code:

- `lib/v8.js`: profiler initialization at lines 54-57, export dereference at
  lines 508-509.
- `src/internal_binding/binding_config.cc`: `hasInspector` is set true at lines
  87-113.
- `src/internal_binding/dispatch.cc`: resolver list has no `profiler` entry and
  unknown bindings return undefined at lines 211-274 and 338-344.

This is a fan-out bug. Fixing this one surface should remove many unrelated
looking dgram, cluster, diagnostics, events, HTTP, HTTP2, TLS, domain, URL, and
zlib failures that only happen because those tests load `node:v8` indirectly.

## Root Cause 2: Global Console Does Not Write

Representative failures:

- `test-console-clear`
- `test-console-count`
- `test-console-diagnostics-channels`
- `test-console-methods`
- `test-console-stdio-setters`
- `test-console`
- pseudo-TTY console color tests
- HTTP/HTTPS proxy tests whose fixtures use `console.log()`

Observed signatures:

- `console.count()` leaves captured stdout empty instead of writing
  `default: 1\n`.
- `console.clear()` writes nothing instead of cursor-control escape sequences.
- `new console.log()` does not throw the expected TypeError.
- Proxy fetch fixture stdout is empty even though the child exits with code 0.
- Proxy request fixtures often contain only the raw response body because
  `res.pipe(process.stdout)` works, while status lines emitted with
  `console.log()` are missing.

Why it happens:

- `lib/internal/console/global.js` creates the global console from
  `internal/console/constructor` and lazily binds `_stdout` / `_stderr`.
- `lib/internal/console/constructor.js` writes through
  `stream.write(string, errorHandler)` in `kWriteToConsole`.
- Direct `process.stdout.write()` works in this build, but `console.log()` and
  `console.error()` produce no output. This points at the global console binding
  path, not at raw stdio.

Relevant code:

- `lib/internal/console/global.js`: global console binding at lines 34-45.
- `lib/internal/console/constructor.js`: stream binding at lines 196-235 and
  write path at lines 282-323.
- `test/fixtures/fetch-and-log.mjs`: proxy fetch fixture logs body with
  `console.log()` at lines 1-3.
- `test/fixtures/request-and-log.js`: status/header lines use `console.log()`,
  while response body uses `res.pipe(process.stdout)` at lines 35-44.

This explains why proxy tests can show outputs such as `Hello World\n` but miss
`Status Code: 200`: the body pipe works, the console status lines do not.

## Root Cause 3: `-p` / `--print` Does Not Print

Representative failures:

- `test-http-max-header-size`
- `test-tls-cipher-list`
- other child-process tests that use `-p`, `-pe`, or `--print`

Observed signatures:

- `build-edge/edge -p "1+1"` exits successfully but prints nothing.
- `test-http-max-header-size` gets empty stdout, coerces it with unary `+`, and
  observes `0 !== 10`.
- `test-tls-cipher-list` receives empty stdout where it expected
  `crypto.constants.defaultCipherList` or `tls.DEFAULT_CIPHERS`.

Why it happens:

- The CLI recognizes `-p` / `--print` and routes to
  `internal/main/eval_string`.
- `lib/internal/main/eval_string.js` passes the `print` option into
  `evalScript()`.
- The current end-to-end behavior evaluates without printing the completion
  value.

Relevant code:

- `src/edge_cli.cc`: eval/print route to `internal/main/eval_string` at lines
  1536-1545.
- `lib/internal/main/eval_string.js`: reads `--print` and passes it through at
  lines 30-77.
- `test/parallel/test-http-max-header-size.js`: expects printed
  `http.maxHeaderSize` at lines 8-11.
- `test/parallel/test-tls-cipher-list.js`: uses `-pe` for cipher checks at lines
  11-32.

The HTTP max-header and TLS cipher tests are probably not proving those option
values are wrong; they are mostly proving `--print` output is missing.

## Root Cause 4: `File` Structured Clone Loses Prototype

Representative failure:

- `test-file`

Observed signature:

```text
TypeError: clonedFile.text is not a function
```

Why it happens:

- `File` extends `Blob` and defines JS-transferable clone hooks
  `[kClone]()` / `[kDeserialize]()`.
- The structured clone implementation should detect cloneable JS-transferable
  values, create a marker, native-clone the marker payload, and deserialize back
  through `internal/file:TransferableFile`.
- In this build, `structuredClone(new File(...))` returns a plain object, so it
  has no `Blob`/`File` methods such as `.text()`.

Relevant code:

- `lib/internal/file.js`: `File` clone/deserialize hooks at lines 117-128 and
  `TransferableFile` at lines 131-137.
- `lib/internal/worker/js_transferable.js`: deserializer factory setup at lines
  33-49 and structuredClone wrapper at lines 112-127.
- `src/internal_binding/binding_messaging.cc`: cloneable-transferable detection
  at lines 669-689, marker preparation at lines 1059-1092, and restoration at
  lines 1212-1281.
- `test/parallel/test-file.js`: expected cloned `File` behavior at lines
  162-181.

## Root Cause 5: Deprecation and Node-Modules Warning Classification

Representative failures:

- `test-buffer-constructor-node-modules`
- `test-buffer-constructor-node-modules-paths`

Observed signatures:

- `--pending-deprecation` child stderr does not match `/DEP0005/`.
- Synthetic call-site tests do not see the expected
  `[DEP0005] DeprecationWarning`.

Why it happens:

- `Buffer()` warning emission depends on
  `getOptionValue('--pending-deprecation')` and
  `internalBinding('util').isInsideNodeModules()`.
- The warning path is present in JS, but the build does not emit the expected
  warning for the tested child process.
- The node-modules detection is native and stack-based; if call-site names or
  CLI option propagation differ from Node, this test flips from warning to no
  warning.

Relevant code:

- `lib/buffer.js`: warning gate and `process.emitWarning(..., 'DEP0005')` at
  lines 187-209.
- `src/edge_util.cc`: `isInsideNodeModules()` stack inspection at lines 521-579.
- `test/parallel/test-buffer-constructor-node-modules.js`: expected pending
  warning at lines 28-36.
- `test/parallel/test-buffer-constructor-node-modules-paths.js`: synthetic
  path expectations at lines 10-37.

## Root Cause 6: Inspector/Profile Flags Are Exposed Without Backing Support

Representative failures:

- `test-domain-dep0097`
- `test-diagnostic-dir-cpu-prof`
- `test-diagnostic-dir-heap-prof`
- `test-crypto-secure-heap` and heapdump/profiling-adjacent failures that load
  `node:v8`

Observed signatures:

- `inspector.open()` throws `ERR_INSPECTOR_NOT_AVAILABLE`.
- CPU/heap profiler diagnostic-dir tests expect child status 0 and profile
  files, but the child exits 1.

Why it happens:

- `internalBinding('config').hasInspector` is true, but
  `internalBinding('inspector')` is a stub whose `open()` method throws
  `ERR_INSPECTOR_NOT_AVAILABLE`.
- CLI option tables include CPU/heap profiler flags, but the implementation only
  forwards a narrow set of V8 `--prof` flags to V8 and does not implement Node's
  `--cpu-prof` / `--heap-prof` profile file lifecycle.

Relevant code:

- `src/internal_binding/binding_config.cc`: `hasInspector = true` at lines
  87-113.
- `src/internal_binding/dispatch.cc`: inspector stub methods at lines 278-335.
- `src/edge_cli.cc`: only `--prof`, `--logfile=`, and
  `--prof-sampling-interval=` are applied as supported V8 profiler flags at
  lines 253-285.
- `test/sequential/test-diagnostic-dir-cpu-prof.js`: expects a CPU profile file
  at lines 27-45.
- `test/sequential/test-diagnostic-dir-heap-prof.js`: expects a heap profile
  file at lines 70-88.

## Root Cause 7: Debug Output Does Not Match Node

Representative failures:

- `test-http-debug`
- `test-http2-debug`

Observed signatures:

- HTTP debug output includes Edge proxy-specific lines such as
  `http createConnection should use proxy ...`, changing the expected stderr.
- HTTP2 debug output contains native `HTTP2 ...` lines, but misses Node's
  sensitive-data warning:
  `Setting the NODE_DEBUG environment variable to 'http2' can expose sensitive data`.

Why it happens:

- Edge's HTTP agent has extra proxy debug logging.
- Edge's native HTTP2 binding writes directly to stderr when
  `NODE_DEBUG_NATIVE` contains `http2`.
- The test expects Node's paired JS/native debug behavior, including the warning
  emitted through Node's debuglog path.

Relevant code:

- `lib/_http_agent.js`: proxy debug line at lines 236-240.
- `src/internal_binding/binding_http2.cc`: native HTTP2 debug writes at lines
  321-323 and 402-415.
- `test/parallel/test-http2-debug.js`: expected sensitive-data warning and
  native lines at lines 10-30.

## Root Cause 8: StringDecoder Does Not Surface `ERR_STRING_TOO_LONG`

Representative failure:

- `test-string-decoder`

Observed signature:

- Large `StringDecoder().write(Buffer.alloc(...))` does not throw
  `ERR_STRING_TOO_LONG`.

Why it happens:

- `lib/string_decoder.js` delegates decoding directly to
  `internalBinding('string_decoder').decode`.
- The native string decoder builds strings from byte ranges but does not mirror
  Node/V8's maximum string length error behavior for this path.

Relevant code:

- `lib/string_decoder.js`: `write()` delegates to native `decode()` at lines
  76-87.
- `src/edge_string_decoder.cc`: `DecodeBinding()` creates the output string at
  lines 493-598.
- `test/parallel/test-string-decoder.js`: expected `ERR_STRING_TOO_LONG` at
  lines 204-210.

## Suggested Fix Order

1. Fix `internalBinding('config').hasInspector` / `profiler` consistency.
   Either expose `hasInspector = false` for this build or provide a stable
   `profiler` binding with no-op `takeCoverage` / `stopCoverage` semantics where
   appropriate. This should collapse the largest failure cluster.
2. Fix global `console.*` output before investigating proxy tests. The proxy
   tests depend heavily on console output from child fixtures.
3. Fix `-p` / `--print` result printing. Recheck `test-http-max-header-size` and
   `test-tls-cipher-list` after that before touching HTTP parser or TLS cipher
   logic.
4. Fix `File` structured clone by ensuring the JS-transferable marker path is
   used and restored for `File`.
5. Revisit deprecation warning stack classification after the console and print
   fixes, because warning tests are sensitive to both stderr and call-site
   formatting.
6. Decide policy for unsupported inspector/profile features: hide/skip them via
   config and feature flags, or implement enough stubs to satisfy Node's
   user-visible contracts.
7. Normalize HTTP/HTTP2 debug output to Node's expected warning and line shape,
   or mark Edge-specific extra diagnostics outside `NODE_DEBUG`/test-visible
   stderr.
8. Add a native string length guard in the string decoder path.

## Verification Targets

After each fix, use targeted tests before the full category run:

```sh
build-edge/edge -e "console.log('hello')"
build-edge/edge -p "1 + 1"
build-edge/edge test/parallel/test-console-count.js
build-edge/edge test/parallel/test-file.js
build-edge/edge test/parallel/test-buffer-constructor-node-modules.js
build-edge/edge test/parallel/test-http-max-header-size.js
build-edge/edge test/parallel/test-tls-cipher-list.js
build-edge/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-events-add-abort-listener.mjs
```

Then rerun the original `make test-only TEST_JOBS=4` command.

## May 7, 2026 QuickJS Native CI Follow-Up

A later `test-and-build-quickjs / build-macos` run showed a newer failure shape
against `build-edge-quickjs-cli/edge`. The largest new clusters had two shared
causes:

1. HTTP/2 sessions failed during native handle setup with:

   ```text
   TypeError: no setter for property
       at Http2Session (native)
       at setupHandle (...)
   ```

   `src/internal_binding/binding_http2.cc` defined `fields` as a getter-only
   class accessor. The native constructor also attempted to assign
   `self.fields = fields_ta`. V8 tolerates the surrounding Node shape, but
   QuickJS reports an inherited accessor-without-setter assignment as a pending
   exception. Removing the constructor-side assignment keeps the getter-backed
   `fields` property and avoids poisoning all HTTP/2 session construction.

2. Several byte-oriented paths produced comma-separated decimal bytes instead
   of Buffer strings. Examples included `test-dgram-pingpong` observing
   `"80,73,78,71"` instead of `"PING"` and TLS off-thread certificate-loading
   tests matching stderr against byte lists instead of text.

   QuickJS `napi_create_buffer*()` returned a marked `Uint8Array`, but it did
   not adopt the runtime `Buffer.prototype`. Once Node bootstrap has called
   `internalBinding('buffer').setBufferPrototype(Buffer.prototype)`, native
   N-API buffers should use that prototype so JS-visible methods such as
   `toString()` behave like Node Buffers. The QuickJS backend now installs
   `globalThis.Buffer.prototype` on native-created buffers when available.

   This prototype install is intentionally best-effort. Native buffer creation
   has already succeeded by the time this compatibility step runs. During early
   bootstrap, or if user code has replaced or damaged `globalThis.Buffer`, the
   N-API call should still return a usable Uint8Array-backed buffer. QuickJS
   keeps exceptions pending, so failures in this optional lookup/prototype path
   are cleared instead of being returned and causing an otherwise successful
   `napi_create_buffer*()` call to fail.

Focused verification after the fixes:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
build-edge-quickjs-cli/edge -e "console.log(Buffer.from('PING').toString()); console.log(Buffer.isBuffer(Buffer.alloc(1)));"
build-edge-quickjs-cli/edge test/sequential/test-dgram-pingpong.js
build-edge-quickjs-cli/edge test/parallel/test-http2-too-many-settings.js
build-edge-quickjs-cli/edge test/parallel/test-tls-off-thread-cert-loading.js
build-edge-quickjs-cli/edge test/parallel/test-tls-off-thread-cert-loading-system.js
```

The local sandbox blocks socket binds with `EPERM`, so the dgram and HTTP/2
focused tests were rerun outside the sandbox. They passed after the native
QuickJS rebuild.

Residual failures seen during the same triage:

- `test-buffer-isascii` and `test-buffer-isutf8` still fail because
  `structuredClone(arrayBuffer, { transfer: [arrayBuffer] })` does not detach
  the original ArrayBuffer under the current QuickJS path. A direct probe showed
  `ab.byteLength` remains nonzero and `new Uint8Array(ab)` still succeeds after
  transfer.
- `test-buffer-creation-regression`, `test-buffer-alloc`, and
  `test-buffer-constants` still expose QuickJS built-in allocation limit and
  error-message differences rather than the native Buffer prototype issue.
