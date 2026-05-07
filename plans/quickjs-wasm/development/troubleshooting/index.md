# Edge QuickJS framework troubleshooting

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Active registry for framework troubleshooting issue notes. |
| **Severity** | Low | Documentation registry only; it does not block runtime behavior. |

This registry lives under the QuickJS WASIX development notes so framework
compatibility work stays attached to the development timeline. Use it to find
existing plans and findings before changing QuickJS runtime code or framework
adapters.

## Workflow

For every new Astro SSR, Vite app, Next app, Node test, hacks/debt, or Wasmer
deploy troubleshooting issue:

- write an issue-specific plan in the matching subdirectory before changing
  code;
- name issue files with a numeric prefix, for example
  `001_<issue_name>.md`;
- keep the plan focused on one observed failure or behavior;
- update the most recent plan pointer in the repo root `AGENTS.md`;
- rerun the targeted reproduction before broadening the fix.

## Hacks And Debt

Use [`hacks/`](hacks/) for compatibility debt that is intentionally suspect:
fallbacks, stubs, V8-shaped bridges, package resolver shortcuts, and other
things that helped bring-up but should be replaced with a cleaner design.

### Active [001_hacks_ledger.md](hacks/001_hacks_ledger.md): QuickJS compatibility debt ledger

Why: QuickJS bring-up has accumulated several useful but incomplete
compatibility bridges, including minimal `Intl`, inspector, `v8` serdes,
CommonJS/ESM facades, resolver heuristics, disabled runtime teardown, and WASIX
linkage patches. This ledger records what is suspicious and how to do it
better.

### ▶️ [006_promise_hooks_microtask_draining.md](hacks/006_promise_hooks_microtask_draining.md): promise hooks and microtask draining

Why: QuickJS currently relies on a patched promise hook path plus scattered
microtask/job draining checkpoints; this needs a coherent scheduler and
async-context design.

### ▶️ [007_commonjs_esm_facades.md](hacks/007_commonjs_esm_facades.md): CommonJS ESM facades

Why: QuickJS currently predeclares CommonJS named exports through scanner-based
synthetic ESM facades; this needs a real loader bridge instead of accumulating
CJS special cases.

## Node Test

For each new Node compatibility test troubleshooting issue, create a plan under
[`node-test/`](node-test/) before changing code.

### ▶️ [001_buffer_limits_and_deprecations.md](node-test/001_buffer_limits_and_deprecations.md): Buffer limits and deprecation parity

Why: Buffer allocation and string-size tests expose QuickJS typed-array limit
messages, missing invalid-string-length checks, and Node module deprecation
classification differences.

### ▶️ [002_console_inspect_and_stack_formatting.md](node-test/002_console_inspect_and_stack_formatting.md): console inspect and stack formatting

Why: console inspection fails on revoked proxies, Map table rows are omitted,
and pseudo-TTY stack formatting uses QuickJS `<input>` frames instead of
Node-style filenames.

### ▶️ [003_node_test_public_api_exports.md](node-test/003_node_test_public_api_exports.md): `node:test` public API exports

Why: ESM tests importing `describe` from `node:test` fail during module linking.

### ▶️ [004_diagnostics_channel_module_loader.md](node-test/004_diagnostics_channel_module_loader.md): diagnostics channel module loader events

Why: ESM module import diagnostics are not published for successful or failed
module loading.

### ▶️ [005_diagnostics_channel_async_context.md](node-test/005_diagnostics_channel_async_context.md): diagnostics channel async context

Why: tracing-channel validation messages differ, async context is lost across
promises, and a worker-thread diagnostics test times out.

### ▶️ [006_eventemitter_asyncresource_private_fields.md](node-test/006_eventemitter_asyncresource_private_fields.md): EventEmitterAsyncResource private-field errors

Why: QuickJS private-field TypeError wording does not match the Node/V8
expectation used by `assert.throws()`.

### ▶️ [007_fetch_response_body_and_proxy_env.md](node-test/007_fetch_response_body_and_proxy_env.md): fetch Response body and HTTP proxy env

Why: `fetch()` can produce an undefined response/body path, causing `.text()`
to throw and HTTP proxy environment fixtures to exit with code 1.

### ▶️ [008_https_proxy_tunnel_errors.md](node-test/008_https_proxy_tunnel_errors.md): HTTPS proxy tunnel errors

Why: HTTPS-over-proxy tests either attempt TLS against the proxy connection or
surface `ERR_PROXY_TUNNEL` without the expected diagnostic message/body.

### ▶️ [009_http_timers_and_header_limits.md](node-test/009_http_timers_and_header_limits.md): HTTP timers and header limits

Why: HTTP timeout warnings, max-header-size test-runner behavior, and some proxy
edge cases do not match Node.

### ▶️ [010_os_constants_and_userinfo.md](node-test/010_os_constants_and_userinfo.md): OS constants and userInfo errors

Why: OS constants immutability and `os.userInfo()` getter-error handling produce
different observable errors from Node.

### ▶️ [011_fastutf8stream_sync_wait.md](node-test/011_fastutf8stream_sync_wait.md): FastUtf8Stream synchronous wait

Why: synchronous UTF-8 stream operations call an Atomics wait path that QuickJS
reports as `cannot block in this thread`.

### ▶️ [012_explicit_resource_management_syntax.md](node-test/012_explicit_resource_management_syntax.md): explicit resource management syntax

Why: stream destroy/dispose tests using `using` / `await using` syntax fail at
QuickJS parse time.

### ▶️ [013_stream_missing_builtins_and_async_iterators.md](node-test/013_stream_missing_builtins_and_async_iterators.md): stream missing builtins and async iterators

Why: stream tests expose missing builtin modules and a readable async-iterator
behavior mismatch.

### ▶️ [014_string_decoder_utf8_boundaries.md](node-test/014_string_decoder_utf8_boundaries.md): StringDecoder UTF-8 boundaries

Why: incomplete or invalid UTF-8 sequences produce two replacement characters
where Node expects one.

### ▶️ [015_url_and_data_url_validation.md](node-test/015_url_and_data_url_validation.md): URL and data URL validation

Why: URL/data URL tests report `ERR_INVALID_ARG_VALUE` in places where Node
expects successful parsing or a more specific validation result.

### ▶️ [016_whatwg_url_inspect_and_searchparams.md](node-test/016_whatwg_url_inspect_and_searchparams.md): WHATWG URL inspect and search params

Why: URL custom inspect output, lone surrogate encoding, and `URLSearchParams`
symbol-conversion TypeError messages differ from Node.

## Astro SSR

For each new Astro SSR troubleshooting issue, create a plan under
[`astro-ssr/`](astro-ssr/) before changing code.

### ▶️ [001_es_module_lexer_webassembly.md](astro-ssr/001_es_module_lexer_webassembly.md): es-module-lexer WebAssembly import

Why: the Astro SSR native ESM entry resolved `es-module-lexer` to its default
WASM-backed build, which expects `globalThis.WebAssembly` and fails under the
QuickJS runtime.

What to investigate: QuickJS-only resolver compatibility for the bare
`es-module-lexer` specifier so it can resolve to the pure JS export already
known to work.

### 🟢 [002_depd_callsite_methods.md](astro-ssr/002_depd_callsite_methods.md): depd CallSite method compatibility

Why: after moving past the `es-module-lexer` issue, Astro SSR reached `depd`,
which expects Node/V8-style structured stack CallSite methods.

What was fixed: QuickJS stack construction now honors the public
`Error.prepareStackTrace` property, and the native `CallSite` prototype exposes
the Node/V8-compatible methods needed by `depd`.

### 🟢 [003_cjs_reexport_named_exports.md](astro-ssr/003_cjs_reexport_named_exports.md): CommonJS re-export named exports

Why: React's public CommonJS entry delegates to another file, so QuickJS's
synthetic ESM facade did not declare named exports such as `createElement`
before module linking.

What was fixed: QuickJS now discovers conservative recursive CommonJS
re-export names in `quickjs_cjs_exports.cc`, declares those names before ESM
linking, and assigns the evaluated `require(...)` properties onto the synthetic
facade. This exists because Node's V8 path already has native
`ModuleWrap`/loader integration; QuickJS needs an equivalent compatibility
bridge until more of that flow can be delegated back to Node's JS loaders.

### 🟠 [004_missing_intl.md](astro-ssr/004_missing_intl.md): missing Intl global

Why: after the `depd` CallSite fix, the Astro SSR entry reaches the generated
Astro server adapter chunk, which creates `new Intl.DateTimeFormat(...)` during
module evaluation.

What was fixed: EdgeJS now installs a deliberately minimal runtime-level
`Intl.DateTimeFormat` fallback when no real implementation exists. It covers
simple framework bootstrap time formatting and is not a full ECMA-402 Intl
implementation.

### 🟠 [005_listen_eperm.md](astro-ssr/005_listen_eperm.md): listen EPERM on localhost

Why: after the minimal Intl fallback, the Astro SSR entry reaches server
startup and logs `listen EPERM: operation not permitted ::1:4321`.

What to investigate: whether the listen failure is sandbox policy, app
configuration, or an EdgeJS TCP/listen runtime behavior difference.

### 🟢 [006_floating_ui_utils_dom.md](astro-ssr/006_floating_ui_utils_dom.md): Floating UI utils DOM subpath

Why: once the Astro server starts and a browser requests `/`, route rendering
fails because QuickJS cannot load `@floating-ui/utils/dom`.

What was fixed: QuickJS package subpath resolution now keeps trying runtime
conditions when a nested condition key such as `types` does not resolve to a
file, allowing `@floating-ui/utils/dom` to reach its nested `default` import
target.

### 🟢 [007_react_remove_scroll_bar_constants.md](astro-ssr/007_react_remove_scroll_bar_constants.md): React Remove Scroll Bar constants subpath

Why: after the Floating UI subpath fix, route rendering reaches
`react-remove-scroll-bar/constants` and QuickJS cannot load that package
subpath.

What was fixed: QuickJS package subpath resolution now tries a subpath
directory's own `package.json` entry metadata after parent `exports` do not
resolve it, matching the CommonJS-compatible shape used by this package.

### 🟢 [008_zustand_ind_create_export.md](astro-ssr/008_zustand_ind_create_export.md): Zustand ind create export

Why: after the React Remove Scroll Bar constants fix, route rendering reaches
Zustand and QuickJS reports that the resolved `zustand/ind` module does not
export `create`.

What to investigate: whether the resolved module path is truncated, whether a
CommonJS re-export pattern is missing from synthetic named export discovery, or
whether the generated app import is invalid.

What was fixed: QuickJS package exports scanning now handles nested condition
objects, root `"."` exports, and the simple `"./*"` wildcard shape so Zustand
resolves to its ESM import targets.

### 🟢 [009_zustand_esm_default_export.md](astro-ssr/009_zustand_esm_default_export.md): Zustand ESM default export

Why: after the Zustand package exports fix, route rendering reaches a new module
linking failure where an import expects a `default` export from the resolved
`zustand/esm` module.

What to investigate: whether the generated app import is valid, whether
`zustand/esm` directory resolution should be allowed, and whether QuickJS's
export declarations match the resolved module.

What was fixed: QuickJS now canonicalizes resolved module filenames through
symlinks, so pnpm symlinked packages resolve their own dependency graph from
the real `.pnpm/.../node_modules` path.

### 🟢 [010_use_gesture_controller_export.md](astro-ssr/010_use_gesture_controller_export.md): Use Gesture Controller export

Why: after pnpm symlink canonicalization, route rendering reaches a new module
linking failure where an import expects `Controller` from a truncated
`.pnpm/@use-...` package path.

What to investigate: identify the full package/module path and determine
whether QuickJS is missing a valid export declaration or resolving the wrong
package entry.

What was fixed: QuickJS now prefers package export runtime conditions in
`import`, `module`, `default` order, so bundler-oriented packages like
`@use-gesture/core` resolve to their ESM `module` target.

### 🟢 [011_route_stack_overflow.md](astro-ssr/011_route_stack_overflow.md): Route stack overflow

Why: after the Use Gesture export fix, route rendering reaches a runtime
`Maximum call stack size exceeded` failure without a detailed stack in Astro's
router log.

What to investigate: capture the real thrown stack and identify whether the
recursion is in module resolution, CommonJS facade evaluation, framework
rendering, or a runtime polyfill.

What was fixed: Edge-created QuickJS runtimes now use a 4 MiB stack guard. The
1 MiB default was too tight for Relay's CommonJS dependency graph plus the
Astro/React SSR render path; 2 MiB fixed module evaluation, and 4 MiB allowed
the full `/` route to render.

### 🟢 [012_wasix_pnpm_symlink_resolution.md](astro-ssr/012_wasix_pnpm_symlink_resolution.md): WASIX pnpm symlink resolution

Why: the Wasmer-packaged Astro standalone entry reaches
`dist/server/renderers.mjs`, but the QuickJS C++ module resolver cannot load
bare `react` from the app's pnpm symlinked `/app/node_modules` tree.

What was fixed: shared QuickJS module path helpers now canonicalize symlink
components during CommonJS and ESM resolution, and the fs binding retries
`stat` through resolved symlink components for Node's JS `realpathSync()`.

### 🟢 [013_lucide_react_chevrondown_export.md](astro-ssr/013_lucide_react_chevrondown_export.md): Lucide React ChevronDown export

Why: after the pnpm symlink fix, the Astro standalone server starts, but
rendering `/` fails because QuickJS does not declare the `ChevronDown` named
export on the synthetic ESM facade for `lucide-react`.

What was fixed: `.js` CJS/ESM classification now reads parsed package metadata
and only treats a package as ESM for top-level `"type": "module"`, avoiding the
false positive from `lucide-react`'s `"repository": { "type": "git" }` plus
top-level `"module"` entry.

### 🟢 [014_pnpm_deploy_externalized_runtime_links.md](astro-ssr/014_pnpm_deploy_externalized_runtime_links.md): pnpm deploy externalized runtime links

Why: the full `stackmachine.com` source tree runs under Wasmer, but the pruned
`.deploy` artifact built from `pnpm deploy --prod --legacy` failed at startup
because Astro's generated server chunks bare-imported externalized packages
such as `piccolore` that existed only inside pnpm's virtual store.

What was fixed: the app's `edge:prepare-deploy` script now scans
`.deploy/dist/server` for bare runtime imports and makes those packages
addressable from the deploy root `node_modules`; `graphql` was also moved to
production dependencies because `graphql-ws` imports it at runtime. Later
Wasmer deploy packaging work materialized this graph into a symlink-free
artifact.

## Vite App

For each new Vite app troubleshooting issue, create a plan under
[`vite-app/`](vite-app/) before changing code.

### 🟠 [001_standalone_build.md](vite-app/001_standalone_build.md): standalone build findings

Why: plain Vite SPA builds do not emit an Astro-style standalone HTTP server
entry, so the existing `server/router.cjs` adapter is real runtime plumbing.

What was found: `vite-plugin-standalone` may package an explicit server entry,
but a plain SPA still needs server semantics from an adapter, generated entry,
or different framework/runtime shape.

## Next App

For each new Next app troubleshooting issue, create a plan under
[`next-app/`](next-app/) before changing code.

### 🟢 [001_standalone_v8_serdes.md](next-app/001_standalone_v8_serdes.md): `require("v8")` / serdes findings

Why: the standard Next.js standalone server reaches `require("v8")`, and the
QuickJS `internalBinding("serdes")` currently returns an empty object.

What changed: QuickJS now exports `Serializer` and `Deserializer` constructors
from `internalBinding("serdes")`; native and WASIX smoke tests verified
`require("v8")` and a plain object `v8.serialize()` / `v8.deserialize()`
round-trip.

### 🟢 [002_standalone_inspector_stub.md](next-app/002_standalone_inspector_stub.md): `require("inspector")` unavailable-inspector stub

Why: after the QuickJS serdes fix, the `private-poker` Next.js standalone server
advances to `require("inspector")`, where `lib/inspector.js` currently throws
`ERR_INSPECTOR_NOT_AVAILABLE` during module load.

What changed: real inspector support remains disabled, but passive consumers can
import the public builtin and receive no-op `url()`, `close()`, and network
hooks while active inspector APIs continue to report inspector-unavailable
errors.

### ▶️ [003_route_stack_exhausted.md](next-app/003_route_stack_exhausted.md): route request stack exhaustion

Why: after the serdes and inspector startup fixes, the `private-poker` Next.js
standalone server starts under Wasmer, but the first request to `/` exits with
`RuntimeError: call stack exhausted`.

Plan: isolate whether the exhaustion is in HTTP dispatch, module loading,
React/Next rendering, user app code, or WASIX/QuickJS stack sizing, then apply a
narrow runtime fix.

## Wasmer Deploy

For each new Wasmer deploy troubleshooting issue, create a plan under
[`wasmer-deploy/`](wasmer-deploy/) before changing deploy packaging code.

### 🟠 [001_pnpm_directory_symlinks_webc.md](wasmer-deploy/001_pnpm_directory_symlinks_webc.md): pnpm directory symlinks in WEBC package

Why: the prepared `.deploy` directory works with local `wasmer run --net .`,
but the app deployed to wasmer.io exits during startup because `/app` cannot
resolve bare `react` from the serialized package.

What was changed: the app deploy preparation now emits a flattened,
symlink-free `.deploy` tree. It builds a runtime import closure, prunes
unimported packages, materializes the remaining package links, removes `.pnpm`,
rewrites virtual-store source imports, copies `wasmer.toml` and optional
`app.yaml`, and validates the final artifact before `wasmer deploy`.

### 🟢 [002_quickjs_wasix_napi_import_module_mismatch.md](wasmer-deploy/002_quickjs_wasix_napi_import_module_mismatch.md): QuickJS WASIX N-API import module mismatch

Why: `quickjs-wasm/build.sh` reached the final WASM link but failed because
`edge_environment_core` declared `napi_*` calls as imports from the `napi`
module while other QuickJS Edge objects referenced the same symbols through
`env`.

What was fixed: the QuickJS provider now compiles `edge_environment_core` with
`NAPI_EXTERN=`, matching the embedded `napi_quickjs` linkage. The WASIX build
now emits `edge.wasm` and `edgejs.wasm`, and the script's final no-N-API-imports
check passes.

### 🟠 [003_ci_safe_mode_missing_quickjs_artifact.md](wasmer-deploy/003_ci_safe_mode_missing_quickjs_artifact.md): CI safe-mode missing QuickJS artifact

Why: the QuickJS `build-wasix-linux` path must build
`build-quickjs-wasix/edgejs.wasm` and package it with the
`quickjs-wasm/wasmer.toml` manifest. The root `wasmer.toml` has been restored to
the main V8 package and is not used for QuickJS WASIX artifacts.

What changed: added a QuickJS WASIX Makefile target, pointed the QuickJS CI
workflow at it, ran the pre-packaging safe-mode smoke test against
`quickjs-wasm/`, packaged `build-quickjs-wasix` as the WASIX dist with
`quickjs-wasm/wasmer.toml`, and skipped the legacy host-N-API `napi_wasmer`
smoke path in this embedded-QuickJS job. Local structural checks passed; full
execution still needs the CI WASIX/Wasmer toolchain. The native Linux and macOS
jobs in `.github/workflows/test-and-build-quickjs.yml` now build/test QuickJS
N-API and use `BUILD_DIR=build-edge-quickjs-cli` for Edge tests and native
dist packaging.

### 🟢 [004_wasix_safe_mode_https_exit.md](wasmer-deploy/004_wasix_safe_mode_https_exit.md): WASIX safe-mode HTTPS exits before callbacks

Why: the main V8/imports `build-wasix-linux` job passed the early safe-mode
smoke tests but failed on HTTPS fetch with empty stdout and callback trampoline
errors reporting `RuntimeError: WASI exited with code: ExitCode::0`.

What changed: `RunEventLoopUntilQuiescent(...)` now drains platform tasks,
process ticks, and microtasks during idle shutdown and after `beforeExit`.
`make build-wasix` completed in native arm64 Ubuntu Docker, and the safe-mode
suite passed under CI-matching Linux `amd64` Docker with Wasmer 7.1.0.
