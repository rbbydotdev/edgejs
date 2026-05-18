# Dev 003: QuickJS Module Loading

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Core QuickJS `ModuleWrap` bridge is implemented and native focused gates pass; the remaining broader VM failures are V8-baseline gaps in Edge.js and are not QuickJS module-loading blockers. |
| **Severity** | High | Full CommonJS parity depends on ESM/CJS interop, synthetic facades, and `require(esm)`. |

## Goal

Make the QuickJS backend support module loading through the same JavaScript
loader and translator stack used by the V8 backend. The native work should
provide the engine-level `ModuleWrap` behavior that Node's JS loaders expect,
not a second package resolver or CJS implementation in C++.

Canonical issue page:

```text
plans/quickjs-wasm/development/troubleshooting/node-compat/napi/007_module_loading.md
```

## Architecture Summary

The existing `src/internal_binding/binding_module_wrap.cc` already exposes the
N-API-facing `internalBinding('module_wrap')` class. It forwards to
`unofficial_napi_module_wrap_*`. The V8 backend implements those calls in
`napi/v8/src/unofficial_napi_contextify.cc`; the QuickJS backend currently
stubs them in `napi/quickjs/src/unofficial_napi.cc`.

The implementation should add a QuickJS internal module record class and route
the existing unofficial API calls to it. Node's JavaScript files under
`lib/internal/modules/` remain responsible for package semantics.

## Subtasks

| Note | Status | Scope |
| --- | --- | --- |
| [001_quickjs_module_api_and_record.md](001_quickjs_module_api_and_record.md) | 🟢 | QuickJS module API patch and core `napi_module_wrap__` record. |
| [002_node_loader_interop_and_synthetic_modules.md](002_node_loader_interop_and_synthetic_modules.md) | 🟢 | Prelinked loader lookup and synthetic modules for CJS, builtins, JSON, and facades. |
| [003_dynamic_import_import_meta_required_facade.md](003_dynamic_import_import_meta_required_facade.md) | 🟠 | Dynamic import, `import.meta`, `require(esm)`, and required module facade parity. |
| [004_verification.md](004_verification.md) | 🟠 | Native N-API tests, Node loader tests, Edge CLI checks, and deferred WASIX/framework smoke checks. |

## Dependency Order

1. `001` must land first. It provides the QuickJS lifecycle split that all other
   module behavior depends on.
2. `002` depends on `001` and unlocks JS loader interop plus CommonJS facades.
3. `003` depends on `001` and `002`; it completes dynamic and synchronous
   interop paths.
4. `004` can start with test design immediately, but the executable tests depend
   on the implementation subtasks.

## Parallelization Notes

The implementation subtasks mostly touch the same QuickJS module-wrap files, so
they should not be assigned to parallel workers with overlapping write sets.
Parallel work is useful for read-only V8 comparison, test planning, and
framework smoke scripts after the core API shape is decided.
