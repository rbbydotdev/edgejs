# EdgeJS N-API QuickJS Notes

This repo contains an N-API implementation backed by QuickJS. Most of the active
work has been in the `napi` submodule/worktree, especially:

- `napi/quickjs/src/js_native_api_quickjs.cc`
- `napi/quickjs/src/unofficial_napi.cc`
- `napi/quickjs/src/internal/`
- `napi/quickjs/tests/`
- `napi/tests/js-native-api/`

## QuickJS WASIX Resume Context

When resuming this work, start with:

```text
plans/quickjs-wasm/development/index.md
```

That file indexes the development phases:

- `dev_001.md`: comparison with the other QuickJS branch and integration plan.
- `dev_002.md`: native Edge QuickJS bootstrap and `ContextifyScript` fix.
- `dev_003.md`: REPL TTY/readline troubleshooting.
- `dev_004.md`: QuickJS promise hooks and microtask/job draining.
- `dev_005.md`: WASIX/Wasmer bootstrap, Atomics, and HTTP stream listener fix.
- `dev_006.md`: Astro, Vite, and Next.js app adapter notes.

Current useful state:

- Native QuickJS-backed Edge CLI can bootstrap and run the HTTP echo server.
- REPL input works with persistent history after the promise hook/microtask fix.
- WASIX Edge QuickJS can run under Wasmer and handle HTTP requests with `--net`.
- The root `wasmer.toml` publishes/uses `sadhbh-c0d3/edgejs-quickjs` at
  `0.0.1`, module `edge`, source `build-quickjs-wasix/edgejs.wasm`.
- Framework app notes use anonymized paths: `~/src/astro-app`,
  `~/src/vite-app`, and `~/src/next-app`.

## Framework Troubleshooting Plans

For each new Astro SSR, Vite app, or Next app troubleshooting issue, write an
action plan before changing code:

```text
plans/quickjs-wasm/troubleshooting/astro-ssr/plan-<name-of-the-issue>.md
plans/quickjs-wasm/troubleshooting/vite-app/plan-<name-of-the-issue>.md
plans/quickjs-wasm/troubleshooting/next-app/plan-<name-of-the-issue>.md
```

After creating a new plan, always update this `AGENTS.md` section so the most
recent plan location for that app points at the new file.

Most recent Astro SSR troubleshooting plan:

```text
plans/quickjs-wasm/troubleshooting/astro-ssr/plan-cjs-reexport-named-exports.md
```

Most recent Vite app troubleshooting note:

```text
plans/quickjs-wasm/troubleshooting/vite-app/findings_standalone-build.md
```

Most recent Next app troubleshooting note:

```text
plans/quickjs-wasm/troubleshooting/next-app/findings-standalone-v8-serdes.md
```

Important commands:

```sh
make build-edge-quickjs-cli JOBS=4
cmake --build build-edge-quickjs-cli --target edge -j4
quickjs-wasm/build.sh
wasmer package build --check .
wasmer run --net .
```

For QuickJS WASIX smoke testing:

```sh
wasmer run . -- --version
wasmer run . -- -e "console.log('hello from quickjs')"
wasmer run --net --volume ./quickjs-wasm:/app . -- /app/echo-server.js
```

Useful diagnostics:

- `EDGE_TRACE_NET=1` traces TCP, stream, HTTP parser, and JS HTTP server paths.
- `EDGE_TRACE_TTY=1` traces native/JS TTY, stream, readline, and REPL history.
- `EDGE_TRACE_BOOTSTRAP=1` traces top-level CLI runner exit status.

Known caveats to remember:

- `JS_FreeRuntime(...)` is currently disabled in
  `napi/quickjs/src/unofficial_napi.cc` until QuickJS GC-owned object lifetime
  leaks are fixed. Do not mistake this for a real teardown fix.
- The vendored QuickJS source has local compatibility patches for promise hooks
  and WASIX atomics. Preserve them unless replacing QuickJS with an upstream
  version that provides equivalent behavior.
- QuickJS N-API class instances may currently look like `napi_external`, so
  Edge stream code intentionally tries wrapper-specific `napi_unwrap(...)`
  paths before raw external fallback.
- For Next.js adapters, avoid `export const runtime = 'edge'` on routes that
  `server/generate-next-dynamic-shells.cjs` must import from
  `.next/server/app/.../page.js`.

## Build And Test Workflow

From the repo root `~/src/edgejs`, use:

```sh
export CMAKE_BUILD_TYPE=Debug
make clean-napi-quickjs
make build-napi-quickjs
```

The built QuickJS N-API test binaries are under:

```text
~/src/edgejs/build-quickjs-napi/tests
```

Run the full QuickJS N-API suite with:

```sh
make test-napi-quickjs
```

If only rerunning already-built tests, this is useful:

```sh
make test-napi-quickjs-only
```

When investigating one failing test, run the specific binary directly, and use
LLDB when the failure is unclear. Example:

```sh
lldb ~/src/edgejs/build-quickjs-napi/tests/napi_quickjs_test_16_reference
```

Inside LLDB, prefer a focused loop:

```text
run --gtest_filter='*Test16Reference*'
bt
frame select <interesting-frame>
p <expr>
```

## Methodology

When a N-API test fails, first reproduce the exact failing test, then inspect the
crash/failure in LLDB before changing code. Fix one behavior at a time and rerun
the targeted test first, then the full `make test-napi-quickjs` suite. Avoid
fixes that make one test pass by changing broad semantics; previous work often
found that narrow QuickJS/V8 semantic differences caused regressions elsewhere.

Before editing, compare with the V8 backend for intent:

```text
napi/v8/src/
```

Use the V8 implementation as behavioral guidance, but do not copy V8-specific
assumptions into QuickJS. QuickJS often has different ownership, context,
microtask, module, stack-limit, and GC semantics.

## Current QuickJS Design Direction

The QuickJS backend has been refactored toward small internal C++ classes under
`napi/quickjs/src/internal/`. If a new `napi_*__` struct/class is needed, put it
in its own header/source pair there, keep fields encapsulated, and use RAII for
QuickJS handles.

Important local conventions:

- Prefer lower_case_naming_convention for new internal helpers.
- Keep `js_native_api_quickjs.cc` focused on the public `extern "C"` N-API
  functions; move helper logic into `internal/` files.
- `napi_value__` wraps a `JSValue` and owns/free-dups according to how it was
  created. Use scope wrapping helpers instead of raw global wrap/unwrap helpers.
- `napi_ref__`, scopes, callbacks, env cleanup hooks, externals, function
  trampolines, and utility code already have internal files; extend those rather
  than reintroducing large local structs in the public implementation file.
- Do not revert unrelated user changes or broad refactors already present in the
  working tree.

## Unofficial N-API QuickJS Surface

`napi/include/unofficial_napi.h` is broad and V8-shaped. The QuickJS
implementation in `napi/quickjs/src/unofficial_napi.cc` should provide real
QuickJS-backed behavior where the engine supports it, and explicit stable
fallbacks where the API is V8-only.

Implemented/expected QuickJS-backed areas include:

- env creation/release and testing teardown
- env cleanup/destroy callbacks
- low-memory/GC request via `JS_RunGC`
- microtask/job draining via `JS_ExecutePendingJob`
- source-map/error arrow-message helpers used by tests
- contextify make/run/dispose/compile/cache-data helpers
- memory/heap/hash metadata approximations from QuickJS APIs
- structured clone and serialize/deserialize using `JS_WriteObject` /
  `JS_ReadObject` where possible

V8-only areas such as full `module_wrap`, CPU/heap profiling, and precise V8
promise internals should not pretend to be complete. Prefer returning
`napi_generic_failure` or sane empty/default outputs after validating arguments,
so embedders get stable behavior and linkable symbols.

## Known Good Baseline

After the recent refactors and unofficial N-API implementation work, this passed:

```sh
make build-napi-quickjs
make test-napi-quickjs
make test-napi-quickjs-only
```

The suite result was 41/41 passing.
