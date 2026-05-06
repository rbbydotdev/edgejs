# QuickJS N-API EdgeJS merge analysis

Date: 2026-05-04

## Scope

This note compares:

- Theirs EdgeJS tree: `~/src/wasmer-io/edgejs`
- Theirs N-API submodule: `~/src/wasmer-io/edgejs/napi`
- Our EdgeJS tree: `~/src/edgejs`
- Our N-API submodule: `~/src/edgejs/napi`

The theirs EdgeJS checkout is on branch `quickjs` at `c2e04af1 update napi`.
Its `napi` submodule points to `wasmerio/napi@1d818e52` (`origin/quickjs`,
`more async fixes`).

Our current tree is on `napi/quickjs-integration` and its `napi` submodule is
at `06207826` (`Unofficial NAPI impl`), with the refactored QuickJS provider and
the standalone QuickJS N-API test harness.

## Executive Summary

The theirs branch has the EdgeJS-side integration we need:

- `EDGE_NAPI_PROVIDER=quickjs` in top-level CMake.
- embedded-provider compile definitions for Edge lifecycle hooks.
- WASIX build/package scaffolding under `quickjs-wasm/`.
- a wasm link check that rejects imported `napi_*`, `node_api_*`, and
  `unofficial_napi_*` symbols.
- small runtime workarounds needed to get the QuickJS-backed Edge binary further
  through startup and smoke tests.

The theirs `napi/quickjs` implementation is much more prototype-shaped than
ours:

- one big env header plus three large source files;
- fetches QuickJS-NG v0.14.0 with `FetchContent`;
- patches QuickJS-NG `quickjs.c` at CMake time for promise hook behavior;
- has no local `napi/quickjs/tests` harness;
- contains several broad stubs/defaults to satisfy Edge/WASIX linkage.

Our QuickJS provider is cleaner and better tested, but it is not yet integrated
as an EdgeJS provider. The right integration direction is to port the EdgeJS
integration and packaging ideas from the theirs branch, while keeping our
refactored provider architecture and filling any missing Edge-required N-API
symbols deliberately.

## Theirs EdgeJS Integration

### CMake Provider Plumbing

In `~/src/wasmer-io/edgejs/CMakeLists.txt`, the theirs branch:

- Extends `EDGE_NAPI_PROVIDER` from `bundled-v8|imports` to
  `bundled-v8|imports|quickjs`.
- Adds:
  - `add_subdirectory("${PROJECT_ROOT}/napi/quickjs" ...)`
  - `target_link_libraries(edge_node_api PUBLIC napi_quickjs)`
  - `target_link_libraries(edge_runtime PUBLIC napi_quickjs)`
- Changes undefined import policy:
  - WASIX + `imports` keeps `EDGE_ALLOW_UNDEFINED_IMPORTS=ON`.
  - `quickjs` forces `EDGE_ALLOW_UNDEFINED_IMPORTS=OFF`.
- Generalizes V8-only embedded behavior to `EDGE_EMBEDDED_NAPI_PROVIDER`.
- Keeps `EDGE_BUNDLED_NAPI_V8` for the V8 provider where V8-specific code still
  needs it.
- Adds `EDGE_QUICKJS_OWNS_NAPI_SYMBOLS` to `edge_node_api` when provider is
  QuickJS.

That last point matters: theirs QuickJS provider owns many public N-API
symbols directly, so `src/node_api.cc` is partially compiled out to avoid
duplicate definitions.

### Header Export Behavior

In `~/src/wasmer-io/edgejs/napi/include/js_native_api.h`, the
theirs branch changes wasm symbol attributes:

- normal WASIX/imports mode still marks N-API declarations as wasm imports;
- `defined(__wasm__) && defined(EDGE_EMBEDDED_NAPI_PROVIDER)` marks them as
  exported/default-visible symbols instead.

This is necessary for an embedded QuickJS provider, because the final wasm
binary should define N-API symbols itself rather than import them from Wasmer.

Our current `~/src/edgejs/napi/include/js_native_api.h` does not
have this embedded-provider wasm export branch yet.

### Edge Runtime Hooks

Two Edge runtime files switch from `EDGE_BUNDLED_NAPI_V8` to the provider-neutral
`EDGE_EMBEDDED_NAPI_PROVIDER`:

- `~/src/wasmer-io/edgejs/src/edge_environment.cc`
- `~/src/wasmer-io/edgejs/src/edge_task_queue.cc`

This lets QuickJS receive the same environment attachment, cleanup, context
token, and promise rejection hooks that the bundled V8 path already used.

### Duplicate Symbol Avoidance

`~/src/wasmer-io/edgejs/src/node_api.cc` wraps many fallback
N-API functions in:

```c++
#if !defined(EDGE_QUICKJS_OWNS_NAPI_SYMBOLS)
...
#endif
```

This avoids duplicate definitions when `napi_quickjs` provides those symbols.
For our integration, this is a design choice:

- either keep this model and make our provider own all required symbols;
- or keep more of `edge_node_api` active as provider-neutral fallback glue.

I prefer the second path initially unless linkage proves it impractical. It
reduces the first integration blast radius.

### WASIX Package Scaffold

The theirs branch adds `~/src/wasmer-io/edgejs/quickjs-wasm/`:

- `build.sh`
- `README.md`
- `wasmer.toml`
- `echo-server.js`

`quickjs-wasm/build.sh` does useful work we should reuse:

- sanitizes host include/link environment variables before cross-build;
- calls `wasix/setup-wasix-deps.sh`;
- builds static WASIX OpenSSL if missing;
- configures CMake with:
  - `-DCMAKE_TOOLCHAIN_FILE=wasix/wasix-toolchain.cmake`
  - `-DEDGE_NAPI_PROVIDER=quickjs`
  - `-DEDGE_BUILD_CLI=ON`
  - `-DBUILD_TESTING=OFF`
- runs `wasm-opt --emit-exnref` when available;
- emits `edge.wasm` and `edgejs.wasm`;
- parses the wasm import section and fails if any N-API symbols remain imports.

That final link check is especially valuable and should come across almost
unchanged.

### Runtime/Library Workarounds Outside N-API

The theirs branch also changes these areas:

- `lib/internal/modules/esm/utils.js`
  - Uses `SafeMap` instead of `SafeWeakMap` when `process.versions.v8` is
    `0.0.0-node.0`.
  - This is a QuickJS WeakRef/GC workaround. It is useful to know about, but we
    should only port it with a focused repro.

- `src/edge_module_loader.cc`
  - Adds better last-NAPI-error reporting when
    `unofficial_napi_contextify_compile_function` fails.
  - This is low-risk and worth porting.

- `src/edge_http_parser.cc`
  - Reads numeric callback return values and handles `HPE_PAUSED`.
  - Likely a correctness improvement independent of QuickJS; worth testing
    against HTTP parser behavior before porting.

- `src/edge_stream_base.cc`
  - Replaces encoding-aware string conversion with UTF-8 text to buffer copy and
    ignores `encoding_name`.
  - This is suspicious as a general change. Do not port blindly; it may have
    been a workaround for a missing QuickJS Buffer/encoding path.

- `wasix/src/wasix_compat.cc`
  - Adds WASIX stubs for `uv_get_free_memory`, `uv_get_total_memory`,
    `uv_resident_set_memory`, `uv_cpu_info`, `uv_interface_addresses`,
    `uv_free_interface_addresses`, and `OSSL_set_max_threads`.
  - These are useful for WASIX link/runtime stability.

### Docs/Plans

The theirs branch adds:

- `~/src/wasmer-io/edgejs/docs/quickjs.md`
- `~/src/wasmer-io/edgejs/plans/quickjs-wasm/plan.md`
- `~/src/wasmer-io/edgejs/plans/quickjs-wasm/task.md`

These capture the intended architecture: QuickJS compiled into the guest wasm
binary as an embedded N-API provider, rather than using the host-provided N-API
imports bridge.

## Theirs `napi/quickjs`

The theirs provider lives at:

`~/src/wasmer-io/edgejs/napi/quickjs`

It contains only six files:

- `CMakeLists.txt`
- `patch_quickjs_ng.cmake`
- `internal/napi_quickjs_env.h`
- `napi_quickjs_env.cc`
- `napi_quickjs_values.cc`
- `napi_quickjs_unofficial.cc`

### Build Model

The theirs provider fetches QuickJS-NG v0.14.0:

```cmake
FetchContent_Declare(quickjs_ng_sources
  URL "https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.14.0.tar.gz"
  URL_HASH SHA256=928e9406addd99eb8623348f2cfcd916eade9a263c60d42be79bc7aee4ee8453
)
```

It builds `quickjs_ng` from `dtoa.c`, `libregexp.c`, `libunicode.c`, and
`quickjs.c`, then links `napi_quickjs` against it.

This is different from our current standalone provider, which expects a QuickJS
library already built from `~/src/edgejs/quickjs` into
`build-quickjs-napi/quickjs/libqjs.a`.

### QuickJS-NG Patch

`patch_quickjs_ng.cmake` mutates fetched `quickjs.c` at configure time to add a
helper that recovers the promise from QuickJS promise resolving functions and to
fire promise hooks around `promise_reaction_job`.

This likely made Edge async hooks or promise context behavior work sooner, but
it is fragile:

- it depends on private QuickJS internals;
- it is tied to a specific QuickJS-NG source shape;
- it rewrites third-party source in the CMake build directory.

For our provider, we should treat this as a behavioral clue, not as code to copy
directly. If promise hook parity requires QuickJS internals, prefer an explicit
patch file or a small local QuickJS fork/change rather than CMake string
replacement.

### Runtime Shape

The theirs provider stores nearly all state in public structs:

- `napi_value__`
- `napi_ref__`
- `napi_handle_scope__`
- `napi_escapable_handle_scope__`
- `napi_callback_info__`
- `napi_deferred__`
- `napi_async_work__`
- `napi_env__`

It tracks `JSRuntime*`, `JSContext*`, last error, pending exception, promise
hooks, cleanup hooks, refs, values, native callbacks, Edge environment hooks,
and context-token callbacks directly on `napi_env__`.

This is straightforward for a prototype, but it is much less maintainable than
our internal class split.

### API Surface

The theirs provider implements or stubs a broad set of symbols:

- core N-API value creation, conversion, properties, references, exceptions,
  arrays, buffers, typed arrays, promises, dates, BigInts;
- env cleanup hooks;
- callback scopes;
- async work;
- threadsafe-function stubs/defaults;
- `napi_get_uv_event_loop` as unsupported;
- many `unofficial_napi_*` hooks used by Edge;
- contextify run/compile/cached-data helpers;
- a small set of module-wrap status/default helpers;
- stable empty/default responses for V8-only profiling/heap APIs.

This broad symbol ownership explains why the EdgeJS branch disabled parts of
`src/node_api.cc` under `EDGE_QUICKJS_OWNS_NAPI_SYMBOLS`.

## Our `napi/quickjs`

Our provider lives at:

`~/src/edgejs/napi/quickjs`

It is at `06207826` and has the newer refactor:

- `src/js_native_api_quickjs.cc`
- `src/unofficial_napi.cc`
- small internal classes under `src/internal/`
- standalone test runners under `tests/runners/`
- `napi/quickjs/tests/CMakeLists.txt`

### Strengths

Compared with the theirs provider, ours has:

- better internal ownership boundaries;
- RAII-ish wrappers for values, refs, scopes, callbacks, cleanup hooks,
  externals, and functions;
- a dedicated QuickJS N-API test suite;
- recent passing baseline of the QuickJS N-API suite;
- more complete unofficial N-API behavior in several areas:
  - env creation/release from an existing QuickJS context for tests;
  - contextify make/run/dispose/compile/cache-data;
  - source-map/error formatting helpers;
  - structured clone and serialize/deserialize via QuickJS object read/write;
  - heap/memory/hash approximations;
  - module-wrap APIs with explicit stable fallbacks.

### Gaps For EdgeJS Integration

Our EdgeJS root does not yet have the theirs top-level integration:

- `~/src/edgejs/CMakeLists.txt` only accepts
  `bundled-v8|imports`.
- `EDGE_EMBEDDED_NAPI_PROVIDER` is not used by Edge runtime hooks yet.
- `napi/include/js_native_api.h` still marks wasm N-API symbols as imports even
  when an embedded provider is desired.
- `quickjs-wasm/` packaging does not exist in our root.

Our provider may also need additional public N-API symbols if we choose the
theirs `EDGE_QUICKJS_OWNS_NAPI_SYMBOLS` model. Examples visible in the
theirs provider but not obviously present in our current `js_native_api`
surface include:

- async work APIs;
- callback scope APIs;
- threadsafe-function APIs;
- `napi_get_uv_event_loop`;
- some `node_api_*` helpers;
- finalizer/post-finalizer style glue currently supplied by Edge's
  `src/node_api.cc`.

We should decide symbol ownership before porting the `src/node_api.cc` guard.

## Recommended Development Plan

### 1. Port The Provider Selection Plumbing

Bring the top-level CMake pieces into `~/src/edgejs`:

- add `quickjs` to `EDGE_NAPI_PROVIDER`;
- add the `napi/quickjs` subdirectory for that provider;
- link `edge_node_api` and `edge_runtime` to `napi_quickjs`;
- set `EDGE_ALLOW_UNDEFINED_IMPORTS=OFF` for `quickjs`;
- introduce `EDGE_EMBEDDED_NAPI_PROVIDER` for embedded providers.

Do this without immediately copying `EDGE_QUICKJS_OWNS_NAPI_SYMBOLS` behavior
unless the link requires it.

### 2. Add Embedded WASM Export Semantics

Port the `js_native_api.h` export/import distinction:

- wasm + imports provider: keep N-API declarations as imports;
- wasm + embedded provider: make N-API declarations default-visible exports.

This is required for a final QuickJS wasm that has no imported N-API symbols.

### 3. Make Our Provider Embeddable By EdgeJS CMake

Adapt our `~/src/edgejs/napi/quickjs/CMakeLists.txt` so it can
work both standalone and as an EdgeJS subdirectory:

- honor parent-provided `NAPI_INCLUDE_ROOT`;
- allow `NAPI_QUICKJS_BUILD_TESTS=OFF` for Edge builds;
- avoid hardcoding `build-quickjs-napi/quickjs/libqjs.a` in the Edge provider
  path;
- decide whether Edge/WASIX should use our checked-in `/quickjs` build or a
  vendored/fetched QuickJS-NG source.

Conservative recommendation: first use the existing `/quickjs` build approach
already passing our tests, then revisit QuickJS-NG only if WASIX build support
requires it.

### 4. Decide N-API Symbol Ownership

Before disabling Edge's fallback `src/node_api.cc` symbols, run a link attempt
and list missing/duplicate symbols.

Preferred first pass:

- keep `src/node_api.cc` fallbacks where they are provider-neutral;
- let `napi_quickjs` own core engine-specific symbols;
- only add `EDGE_QUICKJS_OWNS_NAPI_SYMBOLS` after our provider implements the
  same symbol breadth as the theirs provider.

This should avoid forcing async/threadsafe/uv-loop stubs into our provider
before we know Edge actually needs them for smoke tests.

### 5. Port Runtime Hooks And Low-Risk Fixes

Port these early:

- `EDGE_EMBEDDED_NAPI_PROVIDER` in `edge_environment.cc`;
- `EDGE_EMBEDDED_NAPI_PROVIDER` in `edge_task_queue.cc`;
- better contextify compile error reporting in `edge_module_loader.cc`;
- WASIX compatibility stubs in `wasix/src/wasix_compat.cc`.

Hold back or gate these until reproduced:

- `SafeWeakMap` to `SafeMap` workaround in ESM utils;
- `edge_stream_base.cc` string-write encoding change;
- HTTP parser callback return-value change, unless tests show it is required.

### 6. Add The WASIX Package Scaffold

Port `quickjs-wasm/` into our root after native provider linking works.

Keep the theirs build script's wasm import-section check. That check should
be part of the acceptance criteria for QuickJS/WASIX.

### 7. Verification Sequence

Suggested order:

1. `make build-napi-quickjs`
2. `make test-napi-quickjs-only`
3. Configure native Edge with `-DEDGE_NAPI_PROVIDER=quickjs -DEDGE_BUILD_CLI=OFF`
   and verify `napi_quickjs`, `edge_node_api`, and `edge_runtime` link.
4. Configure native Edge CLI if feasible and run:
   - `edge --version`
   - `edge -e "console.log('hello from quickjs')"`
5. Configure WASIX with `EDGE_NAPI_PROVIDER=quickjs`.
6. Verify final wasm has no imported N-API symbols.
7. Run Wasmer smoke tests:
   - `wasmer run quickjs-wasm/ -- --version`
   - `wasmer run quickjs-wasm/ -- -e "console.log(1 + 1)"`
   - builtin require smoke tests for `buffer`, `events`, `path`, and `http`.

## Open Questions

- Should the embedded provider use our existing QuickJS source tree or switch to
  QuickJS-NG for WASIX?
- Do we need promise hooks deep enough to require QuickJS source changes?
- Should `edge_node_api` remain a provider-neutral fallback library, or should
  each embedded provider own every N-API symbol?
- Which theirs runtime workarounds are true QuickJS requirements versus
  temporary gaps in the prototype provider?
- What is the minimum EdgeJS smoke-test matrix for declaring the first development
  phase done?

## Proposed First Implementation Slice

Start with a narrow integration branch in `~/src/edgejs`:

1. Add `EDGE_NAPI_PROVIDER=quickjs` to top-level CMake.
2. Add `EDGE_EMBEDDED_NAPI_PROVIDER` macro handling.
3. Update `napi/include/js_native_api.h` for embedded wasm exports.
4. Make `napi/quickjs` build as a subdirectory with tests disabled.
5. Attempt native link and resolve only the symbol issues that appear.
6. Keep all runtime workaround ports separate and test-driven.

This should let us preserve our cleaner provider while borrowing the theirs
branch's proven EdgeJS integration shape.
