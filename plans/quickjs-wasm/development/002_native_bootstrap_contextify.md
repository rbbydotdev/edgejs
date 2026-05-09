# QuickJS N-API EdgeJS execution and bootstrap troubleshooting

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Historical bootstrap and contextify investigation. |
| **Severity** | Low | Current contextify status is tracked in `troubleshooting/node-compat/napi/003_contextify.md`. |

Date: 2026-05-04

## Scope

This note records the execution and troubleshooting work done after
`001_merge_analysis.md`.

Goal for this pass:

```sh
./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js
```

should bootstrap EdgeJS with the QuickJS N-API provider, run the user script,
bind the HTTP server, and answer a request.

All our code changes were made under:

- `~/src/edgejs`
- `~/src/edgejs/napi`

## Initial Symptom

Running the script appeared to fail at QuickJS runtime teardown:

```text
Assertion failed: (list_empty(&rt->gc_obj_list)), function JS_FreeRuntime, file quickjs.c, line 2323.
```

The important finding was that this assertion was not the first/root failure.
It was cleanup noise after EdgeJS had already failed during bootstrap.

We used LLDB to break at `JS_FreeRuntime` and inspect `error_out` before the
teardown assertion terminated the process. The original error was:

```text
Failed to execute internal/bootstrap/node: undefined[Error: Failed to execute builtin 'internal/bootstrap/node': ...
```

So the user script was not running yet. EdgeJS was failing while executing
`internal/bootstrap/node`.

## Instrumentation Added

### Edge Builtin/Binding Tracing

In `~/src/edgejs/src/edge_module_loader.cc`:

- Added gated builtin compile tracing:

```sh
EDGE_TRACE_BUILTINS=1
```

This prints lines such as:

```text
EDGE_TRACE_BUILTINS compile internal/vm
```

- Added gated `internalBinding()` tracing:

```sh
EDGE_TRACE_INTERNAL_BINDING=1
```

This prints requests, cache hits, resolved value type, and contextify resolver
state.

- Added `DescribeAndClearPendingException()` and used it when
`ExecuteBuiltinFromNative()` fails in `napi_call_function()`.

This preserves the thrown JS stack in the higher-level native error instead of
returning a generic builtin execution failure.

### QuickJS Contextify Compile Diagnostics

In `~/src/edgejs/napi/quickjs/src/unofficial_napi.cc`:

- Added contextify compile exception annotations:
  - `node:quickjsContextifyCompile`
  - `node:quickjsCompileResourceName`
  - `node:quickjsCompileBuiltinId`
  - `node:quickjsCompileLineOffset`
  - `node:quickjsCompileColumnOffset`
  - `node:quickjsCompileQuickJSLine`
  - `node:quickjsCompileMappedLine`

- Added optional compile tracing:

```sh
EDGE_TRACE_QUICKJS_CONTEXTIFY=1
```

or:

```sh
EDGE_TRACE_BUILTINS=1
```

When enabled, compile exceptions get a one-line summary prepended to the stack.

- Preserved the caught QuickJS exception in N-API's pending/last-exception slot
  before returning `napi_pending_exception`.

- Added `sourceURL` to Function-constructor compiled source so the result object
  can record the intended source resource name.

## Bootstrap Failure 1: `internal/vm`

The first real JavaScript failure was:

```text
TypeError: Cannot convert undefined or null to object
```

The chain was:

- `/lib/internal/bootstrap/node.js:303`

```js
  } = require('internal/process/execution');
```

- `/lib/internal/process/execution.js:41`

```js
  } = require('internal/vm');
```

- `/lib/internal/vm.js:13`

```js
  runInContext,
```

The failing code in `internal/vm.js` is:

```js
const {
  runInContext,
} = ContextifyScript.prototype;
```

`internalBinding('contextify')` did resolve, but `ContextifyScript.prototype`
was missing.

### Root Cause

`ResolveContextifyBinding()` created `ContextifyScript` with
`napi_create_function()`, then tried to read and modify its `prototype`.

Our QuickJS `napi_create_function()` creates a callable QuickJS C function, but
it does not install a JS constructor prototype. Therefore:

```js
ContextifyScript.prototype
```

was `undefined`, and destructuring from it triggered QuickJS `JS_ToObject()` on
`undefined`.

### Current Status

Changed `ResolveContextifyBinding()` to create `ContextifyScript` with
`napi_define_class()` and define prototype methods there:

- `runInContext`
- `createCachedData`

This gives Node's `internal/vm` the constructor shape it expects.

After this change, bootstrap moved past `internal/vm`.

## Runtime Failure 2: Missing Dispose Symbols

After fixing `ContextifyScript`, EdgeJS reached the user script and started
loading `http`, but failed while evaluating `_http_server`.

The new chain reached:

- `/lib/_http_server.js:617`

```js
Server.prototype[SymbolAsyncDispose] = assignFunctionName(SymbolAsyncDispose, async function() {
```

The stack included:

```text
at get description (native)
at call (native)
at assignFunctionName (<input>:943:61)
```

The relevant JS was:

- `/lib/internal/util.js:941`

```js
const symbolDescription = SymbolPrototypeGetDescription(name);
```

### Root Cause

The embedded QuickJS runtime did not provide Node's expected well-known symbols:

- `Symbol.dispose`
- `Symbol.asyncDispose`

Node's primordials therefore captured `SymbolAsyncDispose` as `undefined`.
Later, `_http_server` passed that `undefined` into `assignFunctionName()`, which
attempted to read `Symbol.prototype.description` from a non-symbol.

### Current Status

Added a QuickJS env initialization shim in
`/napi/quickjs/src/unofficial_napi.cc`:

- `EnsureNodeWellKnownSymbols(ctx)`
- `EnsureSymbolProperty(ctx, symbol_ctor, "dispose", "Symbol.dispose")`
- `EnsureSymbolProperty(ctx, symbol_ctor, "asyncDispose", "Symbol.asyncDispose")`

This runs immediately after `JS_NewContext(rt)` in
`unofficial_napi_create_env_with_options()`, before EdgeJS executes
`internal/per_context/primordials`.

After this change, the `http` path got through `_http_server`.

## Verification

Rebuilt the native QuickJS Edge CLI:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Verified the target command:

```sh
./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js
```

Expected output:

```text
quickjs edge echo listening on 3000
```

Verified a request:

```sh
curl -sS http://127.0.0.1:3000/
```

Response:

```text
quickjs edge echo: GET /
```

Important testing note: direct server runs and local `curl` from Codex's sandbox
can be misleading because the sandbox may block bind/connect operations. The
successful verification was done with the command allowed to run outside the
sandbox, matching the behavior expected from a normal user shell.

## Current State

The echo server works when run normally outside the sandbox:

```sh
./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js
```

and responds to HTTP requests on port `3000`.

The main EdgeJS-side functional fix is:

- `ContextifyScript` now uses `napi_define_class()` so
  `ContextifyScript.prototype.runInContext` exists for `internal/vm.js`.

The main QuickJS-side functional fix is:

- QuickJS env creation now installs Node-required `Symbol.dispose` and
  `Symbol.asyncDispose` when missing.

The main diagnostic improvements are:

- builtin compile tracing via `EDGE_TRACE_BUILTINS`
- internal binding tracing via `EDGE_TRACE_INTERNAL_BINDING`
- contextify compile exception annotations via `EDGE_TRACE_QUICKJS_CONTEXTIFY`
- better propagated JS stacks when native builtin execution fails

## Things To Clean Up Or Decide

### Debug Tracing

The tracing is gated behind environment variables, so it is not noisy by
default. Still, before a final cleanup pass we should decide whether to keep all
of these:

- `EDGE_TRACE_BUILTINS`
- `EDGE_TRACE_INTERNAL_BINDING`
- `EDGE_TRACE_QUICKJS_CONTEXTIFY`

`EDGE_TRACE_BUILTINS` and contextify exception annotations are useful. The
broader `EDGE_TRACE_INTERNAL_BINDING` trace may be more temporary.

### QuickJS Teardown Assertion

The original `JS_FreeRuntime` assertion is not the current blocker for
`echo-server.js` working. It can still appear if the process exits during an
earlier failure path or when testing inside the sandbox.

We explicitly deferred that cleanup/GC assertion while chasing bootstrap and
script execution. It should be handled separately with a focused QuickJS
lifetime/handle-scope audit, not mixed into bootstrap fixes.

### N-API Test Coverage

Existing targeted QuickJS N-API tests were added/kept around:

- `napi_create_arraybuffer()` accepting `data == nullptr`
- private symbol creation accepting `NAPI_AUTO_LENGTH`
- contextify compile/cached-data behavior

Before considering this development slice done, rerun:

```sh
CMAKE_BUILD_TYPE=Debug make build-napi-quickjs
make test-napi-quickjs-only
```

and then rebuild the Edge CLI again.

## Commands That Were Useful

Capture pre-teardown failure state:

```sh
lldb --batch \
  -o "breakpoint set -n JS_FreeRuntime" \
  -o run \
  -o "frame select 3" \
  -o "frame variable error_out" \
  -- ./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js
```

Trace builtin compilation:

```sh
EDGE_TRACE_BUILTINS=1 \
./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js
```

Trace internal binding resolution:

```sh
EDGE_TRACE_INTERNAL_BINDING=1 \
./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js
```

Trace QuickJS contextify compile failures:

```sh
EDGE_TRACE_QUICKJS_CONTEXTIFY=1 \
./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js
```

Verify the working server:

```sh
./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js
curl -sS http://127.0.0.1:3000/
```
