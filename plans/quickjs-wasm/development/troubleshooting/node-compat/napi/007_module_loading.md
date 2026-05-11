# Known Issue: Module loading

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | QuickJS now exposes the engine primitives needed by `ModuleWrap`; Node loader policy and CJS interop still belong outside the old C++ compat hack. |
| **Severity** | High | Package resolution and CommonJS/ESM interop decide whether real Node apps can bootstrap. |

## Current State

The QuickJS N-API backend should not carry a parallel C++ approximation of
Node's package resolver, CommonJS wrapper, or ESM translator policy.
The C++ CJS/module-loader hack has been removed: `unofficial_module_loader` and
`quickjs_cjs_exports` no longer exist under `napi/quickjs/src`.

We moved the missing engine-side module hooks into the vendored QuickJS
submodule instead. Commit `577fb31caf2e973b111431b6cb009f7595cc5f7d`
adds QuickJS APIs for:

- enumerating module requests and import attributes;
- installing host-linked module records before QuickJS link time;
- explicit module link, evaluate, status, error, namespace, top-level-await,
  and async-graph queries;
- import-meta initialization and dynamic import callbacks.

The QuickJS N-API `napi_module_wrap__` implementation now adapts Node/V8-shaped
`unofficial_napi_module_wrap_*` calls onto those QuickJS APIs. That is different
from restoring the deleted compatibility resolver: the runtime policy still
belongs in Node's JavaScript loaders/translators or EdgeJS-owned bootstrap code.

## Known Incompatibility

QuickJS now has enough low-level hooks for a host to provide linked modules
directly, but Node packages still expect Node's resolver, CommonJS wrapper
behavior, package conditions, and builtin module names. Framework bundles also
expose pnpm symlink layouts and mixed CJS/ESM graphs that fail if resolution is
only browser-like or filesystem-local.

## Current Status

Keep `napi_module_wrap__` focused on the V8-shaped module wrapper surface and
QuickJS engine state. Route package conditions, CommonJS wrapping, `node:`
builtins, and future loader behavior through Node's JavaScript loaders and
translators. Tests should cover pnpm layouts, builtins, package exports,
CommonJS/ESM interop, and source classification without rebuilding Node's loader
policy in C++.

The superproject must pin `napi/quickjs/src/quickjs` to
`41b00d4cc34cf79188cd9255f050e95ea1a2e9d6` or later. Plain upstream QuickJS at
`c707cf5eda67a97bbff7a60cb2ef124fd4a77420` does not declare the new
`JSModuleImportPhaseEnum`, module wrapper APIs, or `JS_GetCurrentStackTrace`
symbols required by the current QuickJS N-API sources.
