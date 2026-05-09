# Known Issue: Module loading

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | C++ module-loading policy was removed; route through Node JavaScript loaders/translators. |
| **Severity** | High | Package resolution and CommonJS/ESM interop decide whether real Node apps can bootstrap. |

## Current State

The QuickJS N-API backend should not carry a parallel C++ approximation of
Node's package resolver, CommonJS wrapper, or ESM translator policy.

## Known Incompatibility

QuickJS asks the embedder to normalize and load modules, while Node packages
expect Node's resolver, CommonJS wrapper behavior, package conditions, and
builtin module names. Framework bundles also expose pnpm symlink layouts and
mixed CJS/ESM graphs that fail if resolution is only browser-like or
filesystem-local.

## Current Status

Route module loading through Node's JavaScript loaders and translators. That is
the right home for package conditions, CommonJS wrapping, `node:` builtins, and
future loader behavior. Tests should cover pnpm layouts, builtins, package
exports, CommonJS/ESM interop, and source classification without rebuilding
Node's loader policy in C++.
