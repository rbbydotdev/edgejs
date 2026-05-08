# QuickJS Node Compatibility Adapters

| | | Remarks |
| --- | --- | --- |
| **Status** | Active | Compatibility-debt registry for QuickJS Node adapters that should be revisited. |
| **Severity** | Medium | These do not all block current demos, but they can hide correctness debt and future regressions. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

This directory tracks V8-shaped and Node-shaped compatibility adaptations that
helped Edge QuickJS move forward and now live in the dedicated QuickJS compat
layer.

## Overview

### [001_compatibility_adapters_ledger.md](001_compatibility_adapters_ledger.md): current compatibility-debt ledger

What it captures: landed runtime fallbacks, native stubs, promise hook and
microtask draining patches, CommonJS/ESM facade compatibility adapters, resolver heuristics,
QuickJS patches, and blunt compatibility knobs, with ideas for replacing each
one with a better design.

## Issues

### ▶️ [002_disabled_js_free_runtime.md](002_disabled_js_free_runtime.md): disabled `JS_FreeRuntime(...)`

Masks QuickJS object lifetime leaks during teardown.

### ▶️ [003_minimal_intl_fallback.md](003_minimal_intl_fallback.md): minimal `Intl.DateTimeFormat`

Unblocks framework bootstrap while providing only a tiny ECMA-402 subset.

### ▶️ [004_native_inspector_stub.md](004_native_inspector_stub.md): native unavailable `inspector` stub

Makes public inspector imports work even though no real inspector exists.

### ▶️ [005_minimal_v8_serdes.md](005_minimal_v8_serdes.md): minimal `v8` serdes binding

Lets `require("v8")` load without real V8 internals.

### ▶️ [006_promise_hooks_microtask_draining.md](006_promise_hooks_microtask_draining.md): promise hooks and microtask draining

Captures the scheduler and async-context patchwork around QuickJS jobs.

### ▶️ [007_commonjs_esm_facades.md](007_commonjs_esm_facades.md): CommonJS ESM facades

Tracks named-export scanning and synthetic CJS-to-ESM facades.

### ▶️ [008_package_resolver_heuristics.md](008_package_resolver_heuristics.md): package resolver heuristics

Tracks app-driven package condition, subpath, wildcard, and classification fixes.

### ▶️ [009_pnpm_symlink_resolution.md](009_pnpm_symlink_resolution.md): pnpm symlink resolution

Tracks symlink canonicalization and fs stat fallback behavior.

### ▶️ [010_stream_wrapper_unwrap_fallback.md](010_stream_wrapper_unwrap_fallback.md): stream wrapper unwrap fallback

Works around QuickJS class instances looking like raw `napi_external` values.

### ▶️ [011_quickjs_wasix_atomics_patch.md](011_quickjs_wasix_atomics_patch.md): QuickJS WASIX atomics patch

Tracks the local QuickJS atomics guard patch for WASIX.

### ▶️ [012_stack_guard_increase.md](012_stack_guard_increase.md): stack guard increase

Tracks the blunt larger QuickJS stack guard.

### ▶️ [013_v8_shaped_callsite_methods.md](013_v8_shaped_callsite_methods.md): V8-shaped CallSite methods

Tracks QuickJS stack metadata mapped onto Node/V8 CallSite APIs.

### ▶️ [014_contextify_bootstrap_shims.md](014_contextify_bootstrap_shims.md): contextify bootstrap shims

Tracks native QuickJS bootstrap and contextify compatibility work.

### ▶️ [015_public_builtin_loader_special_cases.md](015_public_builtin_loader_special_cases.md): builtin loader special cases

Tracks public builtin import/facade special cases.

### ▶️ [016_napi_extern_wasix_linkage.md](016_napi_extern_wasix_linkage.md): `NAPI_EXTERN=` WASIX linkage

Tracks provider-specific N-API declaration mode.

### ▶️ [017_framework_static_server_adapters.md](017_framework_static_server_adapters.md): framework server adapters

Tracks static/ad hoc framework adapter shapes.

### ▶️ [018_pnpm_deploy_graph_materialization.md](018_pnpm_deploy_graph_materialization.md): pnpm deploy graph materialization

Tracks custom deploy graph materialization for pnpm packages.
