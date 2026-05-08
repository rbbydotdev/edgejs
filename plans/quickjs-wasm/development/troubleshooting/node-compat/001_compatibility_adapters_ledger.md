# Compatibility Adapters Ledger: QuickJS compatibility debt

| | | Remarks |
| --- | --- | --- |
| **Status** | Active | Living list of landed compatibility adapters and incomplete compatibility bridges. |
| **Severity** | Medium | The compatibility adapters are useful, but each one risks hiding a real Node/V8 compatibility gap. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

This is the uncomfortable list. It is based on the current development notes
and should be updated whenever a new compatibility adaptation is added or one of
these is replaced with a real design.

The goal is not to shame the work. Most of these were reasonable pressure-valve
changes while bringing up a new QuickJS N-API backend. The problem starts only
if we forget which parts are transitional adapters.

## Summary

Highest cleanup value:

1. Replace the promise hook / microtask draining patchwork with a clear event
   loop and async-context contract for QuickJS.
2. Replace the CommonJS/ESM facade and package resolver heuristics with a
   coherent Node-compatible loader bridge.
3. Fix QuickJS N-API object identity and lifetime so stream unwrapping and
   `JS_FreeRuntime(...)` do not need special cases.
4. Replace the minimal `Intl`, `inspector`, and `v8` surfaces with explicit
   compatibility modules that advertise exactly what they support.
5. Move every lingering shared-`lib/` diagnostic or behavioral patch into
   provider-owned native code or prove it is provider-neutral.

## Landed Compatibility Adapters And Better Designs

### 1. `JS_FreeRuntime(...)` disabled to avoid teardown aborts

Source notes:

- `development/006_framework_app_adapters.md`
- `AGENTS.md`

What happened: `JS_FreeRuntime(...)` is disabled in
`napi/quickjs/src/unofficial_napi.cc` because QuickJS teardown still sees
GC-owned objects:

```text
Assertion failed: list_empty(&rt->gc_obj_list)
```

Why this is a compatibility adapter: it converts a real ownership/lifetime bug into a leak so
successful runs can exit. That was useful for app bring-up, but it means
teardown tests are not proving runtime correctness.

Better design:

- Audit all `napi_value__`, refs, external wrappers, callbacks, module records,
  and pending jobs that can keep QuickJS values alive past env release.
- Add a debug teardown mode that runs GC, dumps remaining object classes, and
  fails with actionable ownership traces.
- Make env release close scopes, cleanup hooks, refs, function trampolines, and
  module caches in a deterministic order.
- Re-enable `JS_FreeRuntime(...)` in test builds first, then in normal builds.

### 2. Minimal `Intl.DateTimeFormat` fallback

Source notes:

- `troubleshooting/astro-ssr/004_missing_intl.md`
- `development/dev_001_pr_cleanup_containment/003_intl_fallback_module.md`

What happened: Edge QuickJS installs a deliberately tiny
`globalThis.Intl.DateTimeFormat` when no real `Intl` exists. It supports enough
for Astro logger timestamps and some framework bootstrap paths.

Why this is a compatibility adapter: it looks like `Intl`, but it is not ECMA-402. It has no real
locale negotiation, calendar behavior, numbering systems, time-zone support, or
ICU-backed formatting. Any code past the narrow timestamp path can be misled.

Better design:

- Either compile/link a real ICU or smaller ECMA-402 provider for QuickJS, or
  expose `Intl` as unsupported and make the compatibility matrix explicit.
- If keeping a fallback, put it behind a clearly named internal capability and
  document the supported subset in code and tests.
- Add focused tests that prove unsupported options do not silently claim full
  support.

### 3. Native `inspector` unavailable stub

Source notes:

- `troubleshooting/next-app/002_standalone_inspector_stub.md`
- `development/dev_001_pr_cleanup_containment/002_native_inspector_fallback.md`

What happened: public `require("inspector")` and `require("node:inspector")`
return a native fallback even though `internalBinding("config").hasInspector`
and `process.features.inspector` remain false. Passive APIs such as `url()`
work as no-ops; active APIs throw unavailable errors.

Why this is a compatibility adapter: the public module is loadable while builtin metadata still
partly says it cannot be required. `Session` is intentionally smaller than
Node's real implementation and does not fully inherit from `EventEmitter`.

Better design:

- Decide the contract: either inspector is absent and imports fail consistently,
  or it is present as a documented unavailable-inspector module.
- If present, make the public module shape match Node: `Session` should inherit
  from `EventEmitter`, passive APIs should be stable, and metadata should agree
  with `require()` behavior.
- Keep `hasInspector=false` for runtime feature gating, but add a separate
  "public inspector stub available" capability if needed.

### 4. Minimal QuickJS `internalBinding("serdes")` for `require("v8")`

Source notes:

- `troubleshooting/next-app/001_standalone_v8_serdes.md`
- `development/007_framework_standalone_builds.md`

What happened: QuickJS now exports `Serializer` and `Deserializer` constructors
so `require("v8")` can load and `v8.serialize()` / `v8.deserialize()` can
round-trip plain objects through QuickJS object write/read helpers.

Why this is a compatibility adapter: the public builtin is named `v8`, but QuickJS cannot and
should not pretend to expose real V8 serializer, heap, coverage, or profiling
internals. Plain object serdes is useful, but the surface area is much larger
than the implementation.

Better design:

- Build an explicit compatibility layer for the `v8` builtin with a tested
  support matrix: implemented, approximate, unavailable.
- Implement serializer features against Node's observable behavior, not just
  QuickJS bytecode/object serialization convenience.
- Return stable, documented failures for true V8-only functionality instead of
  exporting partial objects that later throw surprising TypeErrors.

### 5. Promise hooks and microtask/job draining patchwork

Source notes:

- `development/004_promise_hooks_microtasks.md`
- `development/003_repl_tty_readline.md`
- `troubleshooting/wasmer-deploy/004_wasix_safe_mode_https_exit.md`
- `troubleshooting/node-test/005_diagnostics_channel_async_context.md`

What happened: QuickJS now has local promise hook integration, explicit
`JS_ExecutePendingJob(...)` draining, a real `JS_EnqueueJob(...)` path for
`unofficial_napi_enqueue_microtask(...)`, async-context frame preservation
around promise jobs, and event-loop shutdown draining that runs platform tasks,
process ticks, and microtasks until quiescent.

The vendored QuickJS source was patched so `promise_reaction_job()` emits
before/after promise hook events. The N-API layer then captures and restores
`continuation_preserved_embedder_data` for promise continuations so REPL
history, `await`, and `AsyncLocalStorage` can work.

Why this is a compatibility adapter: it is not one cohesive scheduler design yet. It is a series
of pressure fixes added where the next symptom appeared: REPL history stuck
after `await hnd.close()`, microtasks not draining, safe-mode HTTPS callbacks
exiting before completion, and diagnostics-channel async context still showing
gaps. The QuickJS source patch may be necessary, but the runtime now has several
places that can drain jobs, ticks, and platform tasks, which risks reentrancy,
wrong ordering, missed async context, or shutdown-only behavior that masks a
normal event-loop bug.

Better design:

- Write down the QuickJS event-loop contract: when Node ticks run, when QuickJS
  jobs run, when platform tasks run, when `beforeExit` fires, and when shutdown
  is allowed to stop.
- Centralize queue draining behind one runtime scheduler/checkpoint API instead
  of scattering drains through callback scopes, CLI shutdown, safe-mode idle
  loops, and ad hoc checkpoints.
- Keep the QuickJS promise hook source change as an explicit patch file with
  tests, or move to a QuickJS/QuickJS-NG version that emits equivalent hooks.
- Add ordering tests for `process.nextTick`, `queueMicrotask`, promises,
  `setImmediate`, timers, native callbacks, `beforeExit`, and rejected promises.
- Add async-context tests that cross promises, `await`, timers, I/O callbacks,
  and diagnostics-channel tracing before declaring the hook path done.

### 6. CommonJS compatibility adapters: named-export scanner and synthetic ESM facades

Source notes:

- `troubleshooting/astro-ssr/003_cjs_reexport_named_exports.md`
- `troubleshooting/node-test/003_node_test_public_api_exports.md`

What happened: QuickJS predeclares named exports for CommonJS facades by
statically scanning export patterns and following simple literal re-export
forms such as `module.exports = require("./target.js")`.

Why this is a compatibility adapter: it exists because QuickJS must know ESM export names before
link time, while CommonJS export objects are only known after evaluation. The
scanner is conservative, but it is still a parallel approximation of Node's
mature CJS/ESM translator path.

Better design:

- Implement a clearer Node-compatible module bridge, ideally closer to
  `ModuleWrap` and Node's JS loaders/translators.
- Use a real lexer/parser for CJS named-export discovery where Node does, not
  ad hoc pattern matching.
- Centralize facade generation for packages and builtins so `node:test`,
  `react`, and other CJS-to-ESM cases share one rule set.
- Treat CommonJS as a first-class loader mode, not a collection of package
  special cases: one path should decide classification, wrapper execution,
  named export declaration, `default`, `module.exports`, and re-export copying.
- Add fixture tests for recursive re-exports, conditional exports, `default`,
  `module.exports`, live bindings, getters, late mutations, circular requires,
  and missing names.

### 7. Package resolver condition and subpath heuristics

Source notes:

- `troubleshooting/astro-ssr/006_floating_ui_utils_dom.md`
- `troubleshooting/astro-ssr/007_react_remove_scroll_bar_constants.md`
- `troubleshooting/astro-ssr/008_zustand_ind_create_export.md`
- `troubleshooting/astro-ssr/010_use_gesture_controller_export.md`
- `troubleshooting/astro-ssr/013_lucide_react_chevrondown_export.md`

What happened: the QuickJS resolver learned several compatibility behaviors:

- try nested package condition objects rather than stopping on `types`;
- inspect a subpath directory's own `package.json`;
- support simple wildcard export shapes;
- prefer runtime-ish conditions such as `import`, `module`, then `default`;
- parse package metadata to avoid false `.js` ESM classification from unrelated
  keys like repository `"type": "git"`.

Why this is a compatibility adapter: each fix was narrow and test-driven, but together they are
becoming a hand-built Node/package-manager resolver. That is dangerous because
package resolution has many edge cases and tiny differences can choose the wrong
runtime file.

Better design:

- Treat package resolution as one owned subsystem with a spec-aligned resolver,
  a package metadata cache, and fixture coverage copied from real packages.
- Separate ESM resolution, CommonJS resolution, and bundler compatibility
  choices instead of blending them inside one fallback chain.
- Keep app-specific package discoveries as tests, not branches.
- Compare each resolver decision against native Node for both `require()` and
  `import()`.

### 8. pnpm symlink canonicalization and fs stat fallback

Source notes:

- `troubleshooting/astro-ssr/009_zustand_esm_default_export.md`
- `troubleshooting/astro-ssr/012_wasix_pnpm_symlink_resolution.md`
- `troubleshooting/wasmer-deploy/001_pnpm_directory_symlinks_webc.md`

What happened: QuickJS module resolution and fs stat behavior were adjusted to
canonicalize pnpm symlinked package paths and retry through resolved symlink
components.

Why this is a compatibility adapter: the fix is necessary for pnpm graphs, but symlink handling
is now spread across resolver and fs behavior. It can hide differences between
host filesystems, WASIX package filesystems, and materialized deploy artifacts.

Better design:

- Build one realpath/symlink service shared by CJS resolution, ESM resolution,
  fs bindings, and WASIX packaging checks.
- Cache realpaths with invalidation rules appropriate for the runtime.
- Make deploy packaging either preserve symlink semantics correctly or
  materialize a validated symlink-free graph before runtime.
- Add pnpm fixture tests for dependency-scoped package resolution.

### 9. Stream wrapper-specific unwrapping before raw external fallback

Source notes:

- `development/005_wasix_wasmer_http.md`
- `AGENTS.md`

What happened: QuickJS class instances could look like `napi_external`, so the
stream conversion path treated a wrapped `TCP` object as a raw external pointer.
The fix was to try TCP/Pipe/TTY wrapper-specific `napi_unwrap(...)` paths before
falling back to raw external data.

Why this is a compatibility adapter: the stream fix is careful and validated, but it works around
a deeper N-API identity problem. A JavaScript class instance should not be
ambiguous with a raw external in the first place.

Better design:

- Fix QuickJS N-API type tagging so wrapped objects and raw externals have
  distinct observable classifications.
- Make `napi_typeof`, `napi_unwrap`, and external handling match Node-API
  semantics for class instances.
- Keep stream-base conversion narrow, but remove the need for defensive
  wrapper probes once N-API object identity is correct.

### 10. QuickJS WASIX atomics guard patch

Source notes:

- `development/005_wasix_wasmer_http.md`
- `development/006_framework_app_adapters.md`
- `AGENTS.md`

What happened: vendored QuickJS was patched so WASIX builds can expose
`Atomics` and `SharedArrayBuffer` when `__wasm_atomics__` is defined, instead
of excluding all `__wasi__` targets unconditionally.

Why this is a compatibility adapter: it is a local engine patch. It may be correct, but it is
still a fork delta that must be preserved and revalidated whenever QuickJS is
updated.

Better design:

- Convert the change into an explicit patch file with rationale, upstream
  context, and tests.
- Upstream it or track it against a QuickJS/QuickJS-NG version that supports
  WASIX atomics cleanly.
- Add build-time and runtime smoke tests for `Atomics`,
  `SharedArrayBuffer`, and any blocking-wait limitations.

### 11. Blunt QuickJS stack guard increase

Source notes:

- `troubleshooting/astro-ssr/011_route_stack_overflow.md`
- `troubleshooting/next-app/003_route_stack_exhausted.md`

What happened: Edge-created QuickJS runtimes use a larger stack guard, with
Astro validation showing that 4 MiB allowed a route render that overflowed at
the default.

Why this is a compatibility adapter: increasing stack gives real apps room to run, but it does
not explain whether the depth is normal framework recursion, inefficient
CommonJS facade evaluation, resolver recursion, or QuickJS stack accounting.

Better design:

- Instrument stack depth around module loading, CJS facade evaluation, React
  rendering, and HTTP dispatch.
- Remove accidental recursion before raising limits.
- Make stack sizing explicit per target, with WASIX/native defaults justified by
  measured framework workloads.
- Keep the Next stack exhaustion issue open until request-time failure is
  isolated separately.

### 12. V8-shaped CallSite compatibility methods

Source notes:

- `troubleshooting/astro-ssr/002_depd_callsite_methods.md`
- `development/002_native_bootstrap_contextify.md`

What happened: QuickJS stack construction learned to honor public
`Error.prepareStackTrace`, and native `CallSite` objects gained a conservative
set of Node/V8-style methods needed by packages such as `depd`.

Why this is a compatibility adapter: V8's CallSite API is not a neutral JavaScript standard.
QuickJS does not naturally track all the same metadata, so some methods are
approximations.

Better design:

- Define a QuickJS-owned structured stack frame model with explicit available
  and unavailable fields.
- Map that model to Node/V8 CallSite methods in one compatibility layer.
- Add tests for `Error.prepareStackTrace`, file names, eval origins,
  constructor/method flags, async frames, and missing metadata.
- Avoid package-specific stack behavior.

### 13. Native QuickJS bootstrap/contextify shims

Source notes:

- `development/002_native_bootstrap_contextify.md`
- `development/007_framework_standalone_builds.md`

What happened: QuickJS needed environment initialization and contextify compile
behavior shaped enough for Node's bootstrap and `ContextifyScript` paths.

Why this is a compatibility adapter: contextify is a V8-shaped unofficial N-API surface. The
QuickJS implementation can easily become a set of special cases for whatever
bootstrap path fails next.

Better design:

- Treat contextify as a real subsystem with documented QuickJS semantics:
  script lifetime, cached data, compile errors, filename/line offsets, realm
  behavior, and source maps.
- Compare against the V8 backend for observable Node behavior, but do not copy
  V8-only assumptions into QuickJS internals.
- Add targeted contextify tests before changing framework bootstrap code.

### 14. Public builtin loader special cases

Source notes:

- `development/dev_001_pr_cleanup_containment/002_native_inspector_fallback.md`
- `troubleshooting/node-test/003_node_test_public_api_exports.md`

What happened: the module loader special-cases public `inspector` imports, and
the new node-test notes identify missing builtin ESM export declarations such
as `describe` from `node:test`.

Why this is a compatibility adapter: every builtin that needs special casing makes the loader
less predictable. Builtins should have one metadata source that controls
CommonJS require, ESM import, `node:` aliases, public named exports, and
category metadata.

Better design:

- Build a builtin registry with CJS id, `node:` id, category metadata, public
  ESM names, lazy initialization, and unsupported-feature policy.
- Generate both `require()` and ESM facade behavior from that registry.
- Test `require("x")`, `require("node:x")`, `import "node:x"`, and named ESM
  imports for every builtin that QuickJS exposes.

### 15. `NAPI_EXTERN=` and provider-specific WASIX linkage fixes

Source notes:

- `development/008_runtime_change_containment_rollback.md`
- `troubleshooting/wasmer-deploy/002_quickjs_wasix_napi_import_module_mismatch.md`

What happened: targets that include N-API headers before linking
`napi_quickjs` must compile with `NAPI_EXTERN=` so wasm objects do not disagree
about whether unresolved `napi_*` symbols import from `napi` or `env`.

Why this is a compatibility adapter: it is a build-system fix for a real linkage requirement,
but it is easy to miss on a future target. The rule lives as tribal knowledge
unless it is encoded centrally.

Better design:

- Move embedded-provider import/export semantics into a single CMake interface
  target or generated config header.
- Make every target that consumes N-API inherit the right declaration mode from
  `EDGE_NAPI_PROVIDER`.
- Add a post-link check for no imported `napi_*` symbols in embedded QuickJS
  WASIX builds, and fail with the target that compiled with the wrong mode.

### 16. Framework static/ad hoc server adapters

Source notes:

- `development/006_framework_app_adapters.md`
- `development/007_framework_standalone_builds.md`
- `troubleshooting/vite-app/001_standalone_build.md`

What happened: Astro and Vite validation used small server adapters or static
serving shapes to get framework output running under Edge QuickJS.

Why this is a compatibility adapter: these adapters prove runtime capability, but they are not a
general framework integration story. They can accidentally bypass the actual
framework server semantics that users expect.

Better design:

- Define supported deployment modes per framework: static assets, standalone
  Node server, generated dynamic shell, or unsupported.
- Keep adapters generated and tested as build artifacts, not hand-maintained
  one-offs.
- Add framework fixtures that check routing, assets, headers, streaming, error
  pages, and environment variables under native QuickJS and WASIX.

### 17. Deploy graph materialization for pnpm packages

Source notes:

- `troubleshooting/astro-ssr/014_pnpm_deploy_externalized_runtime_links.md`
- `troubleshooting/wasmer-deploy/001_pnpm_directory_symlinks_webc.md`

What happened: deployment preparation scans runtime imports, materializes pnpm
package links, removes `.pnpm`, rewrites virtual-store source imports, and
validates a symlink-free artifact.

Why this is a compatibility adapter: it is pragmatic and may be the right packaging direction,
but it is also a custom package graph transformer. That can go stale as pnpm,
framework bundlers, and package export patterns change.

Better design:

- Make deploy preparation a tested package-graph tool with explicit inputs,
  outputs, and invariants.
- Prefer framework/bundler output that already contains a closed runtime graph
  where possible.
- Add validation that every bare runtime import resolves inside the final
  artifact under the same resolver the QuickJS runtime uses.

## Suspicious Ideas That Were Held Back Or Should Stay Held Back

These appeared in earlier notes as possible shortcuts, but should not become
architecture without a fresh design pass:

- Fake `globalThis.WebAssembly` just to satisfy `es-module-lexer`; better to
  resolve to the pure JS package export or implement real WebAssembly support.
- `SafeWeakMap` to `SafeMap` in ESM utils; better to fix WeakRef/GC lifetime or
  prove the substitution is semantically safe.
- Broad shared `lib/` patches for tracing or QuickJS behavior; better to keep
  provider-specific diagnostics in `napi/quickjs/` or neutral native tracing in
  `src/`.
- Loader transforms for `using` / `await using`; better to get engine support
  for explicit resource management or skip unsupported syntax honestly.
- Globally rewriting QuickJS error messages to match V8; better to normalize
  errors at Node API boundaries where Node promises a specific message.

## Cleanup Order

Suggested order for paying this down:

1. Scheduler and async context:
   centralize microtask/job/tick draining and prove ordering.
2. N-API lifetime and object identity:
   re-enable teardown and remove stream wrapper probes.
3. Loader architecture:
   centralize package resolution, builtin metadata, and CJS/ESM facades.
4. Runtime capability modules:
   formalize `Intl`, `inspector`, `v8`, and other partial builtins with support
   matrices and tests.
5. WASIX build correctness:
   centralize embedded-provider N-API declaration mode and QuickJS patch
   management.
6. Framework/deploy adapters:
   turn one-off deploy graph and static server work into repeatable tools with
   fixture coverage.
