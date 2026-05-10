# Subtask 004: Verification

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Native build, N-API, Edge CLI, and focused module-wrap checks pass; WASIX is deferred and the two broader VM failures are excluded because they also fail under Edge's V8 backend. |
| **Severity** | High | Module loading regressions affect bootstrap, framework apps, and WASIX packaging. |

## Scope

Build the focused and end-to-end verification suite for QuickJS module loading
parity.

## Write Ownership

Primary files:

- `napi/quickjs/tests/`
- `napi/tests/js-native-api/`
- `plans/quickjs-wasm/development/troubleshooting/node-compat/napi/007_module_loading.md`

Potential smoke scripts should live near existing framework or WASIX smoke
infrastructure rather than inside app output directories.

## Dependencies

Can start as test design immediately. Executable test updates depend on the
implementation subtasks.

## Target Test Matrix

- Classic CJS:
  - local `require('./file.cjs')`;
  - directory `index.js`;
  - package `main`;
  - package `exports`;
  - `node:` and bare builtins.
- ESM:
  - static local import;
  - package import through JS resolver;
  - import attributes for JSON;
  - missing export diagnostics.
- Interop:
  - ESM imports CJS named/default/module.exports;
  - CJS requires synchronous ESM;
  - CJS requires ESM with TLA and receives `ERR_REQUIRE_ASYNC_MODULE`;
  - CJS and ESM cache sharing for JSON and CJS.
- Runtime callbacks:
  - dynamic `import()`;
  - `import.meta.url`;
  - required module facade and `__esModule`.
- Packaging:
  - pnpm symlink/materialized layouts;
  - WASIX QuickJS rebuild and smoke commands as a separate, deferred gate;
  - Astro/Vite/Next app smoke checks once core native tests pass.

## Required Commands

Use the focused checks first:

```sh
make build-napi-quickjs
make test-napi-quickjs-only
```

Then run the complete local gates:

```sh
make test-napi-quickjs
make build-edge-quickjs-cli JOBS=4
cmake --build build-edge-quickjs-cli --target edge -j4
```

For the current native module-loading verification pass, WASIX is explicitly
excluded. When WASIX is re-enabled, changes under `src/`, `lib/`, or
`napi/quickjs/` should finish with:

```sh
cd /Users/syrusakbary/Development/edgejs/quickjs-wasm/ && ./build.sh
```

Smoke commands after a successful WASIX build:

```sh
wasmer run . -- --version
wasmer run . -- -e "console.log('hello from quickjs')"
wasmer run --net --volume ./quickjs-wasm:/app . -- /app/echo-server.js
```

## Verification Run

Passing native checks:

- `make build-napi-quickjs`
- `make test-napi-quickjs` (`45/45` CTest tests passing)
- `make build-edge-quickjs-cli JOBS=4`
- `test/parallel/test-internal-module-wrap.js` with the QuickJS Edge CLI
- `test/parallel/test-vm-module-synthetic.js`
- `test/parallel/test-vm-module-import-meta.js`
- `test/parallel/test-vm-module-dynamic-import.js`
- `test/parallel/test-vm-module-hastoplevelawait.js`
- `test/parallel/test-vm-module-hasasyncgraph.js`
- `test/parallel/test-vm-module-link.js`
- `test/parallel/test-vm-module-modulerequests.js`
- manual CommonJS `require(esm)` smoke returning `default`, named export, and
  `__esModule`

Deferred gates:

- `cd /Users/syrusakbary/Development/edgejs/quickjs-wasm/ && ./build.sh`
- WASIX smoke commands under `wasmer run`
- Astro/Vite/Next framework smoke checks

Excluded Edge-wide VM baseline gaps:

- `test/parallel/test-vm-module-basic.js` reaches module execution, then fails
  on QuickJS context inspection shape. The same test is not a useful QuickJS
  module-loading gate yet because `build-edge/edge` with V8 hangs on the
  `SourceTextModule.evaluate({ timeout })` case.
- `test/parallel/test-vm-module-linkmodulerequests.js` reaches module
  assertions under QuickJS, but should not gate QuickJS parity yet. Rebuilt
  `build-edge/edge` with V8 fails the same file: `import source Foo from "foo"`
  is still a syntax error and the instantiate diagnostic is only
  `Module is not linked`.

V8 baseline check:

```sh
cmake --build build-edge --target edge -j4
build-edge/edge -p "process.versions.v8"
NODE_SKIP_FLAG_CHECK=1 build-edge/edge --experimental-vm-modules test/parallel/test-vm-module-basic.js
NODE_SKIP_FLAG_CHECK=1 build-edge/edge --experimental-vm-modules --js-source-phase-imports test/parallel/test-vm-module-linkmodulerequests.js
```

Observed V8 version: `13.6.233.17-node.0`. The basic test timed out after 15s;
the link-module-requests test passed 2/4 and failed the source-phase syntax and
diagnostic cases. These tests become valid QuickJS gates only after the Edge V8
backend passes them or the repository carries an Edge-specific expectation.

## Symbol Dispose Regression

The old `_http_server` bootstrap failure:

```text
at get description (native)
at assignFunctionName
```

was reproduced as missing `Symbol.dispose` / `Symbol.asyncDispose` in QuickJS.
The shim was restored in `napi/quickjs/src/unofficial_napi.cc` and covered by
`napi/tests/js-native-api/13_symbol/test.js`.
