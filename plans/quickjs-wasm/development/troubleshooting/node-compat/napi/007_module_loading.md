# N-API Compat: Module Loading

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/module_loading.{h,cc}`. |
| **Severity** | High | Package resolution and CommonJS/ESM interop decide whether real Node apps can bootstrap. |

## Source Pair

- `napi/quickjs/src/compat/module_loading.h`
- `napi/quickjs/src/compat/module_loading.cc`

## What It Does

The module-loading adapter contains the QuickJS-side resolver and translator glue needed for Node-shaped modules. It handles builtin and `node:` specifiers, CommonJS facade generation, package subpath and exports-style resolution, symlink-aware filesystem lookup, import-meta details, and source classification needed before QuickJS evaluates a module.

## Why It Is Needed

QuickJS asks the embedder to normalize and load modules, while Node packages expect Node's resolver, CommonJS wrapper behavior, package conditions, and builtin module names. Framework bundles also expose pnpm symlink layouts and mixed CJS/ESM graphs that fail if resolution is only browser-like or filesystem-local. Keeping this logic in one adapter made it possible to remove scattered loader special cases and focus future work on a real Node loader path.

## Could We Do It Better

Yes: the desired endpoint is to route module loading through Node's JavaScript loaders and translators instead of maintaining a parallel C++ approximation. That would make package conditions, CommonJS wrapping, `node:` builtins, and future Node loader behavior easier to inherit. Until then, the adapter should keep using structured package metadata, avoid source-text heuristics where a parser is available, and add targeted tests for pnpm, builtin, and package-exports cases.

## Reconciled Notes

This article reconciles the earlier CommonJS/ESM facade, package resolver, pnpm symlink, and public builtin loader notes. The implementation has been extracted into `napi/quickjs/src/compat` and is now documented by the module-loading concern.
