# Compatibility Adapter: CommonJS named-export facades

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | High | Affects all CJS-to-ESM package and builtin interop. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/003_cjs_reexport_named_exports.md`
- `plans/quickjs-wasm/development/troubleshooting/node-test/003_node_test_public_api_exports.md`

## What Is The Compatibility Adapter

QuickJS predeclares named exports for CommonJS facades by statically scanning
export patterns and following simple literal re-export forms such as:

```js
module.exports = require("./target.js")
```

## Why It Is Suspect

QuickJS needs ESM export names before link time, while CommonJS only knows its
real export object after evaluation. The scanner is a parallel approximation of
Node's CJS/ESM translator path. It can miss getters, late mutations, circular
requires, and non-literal export construction.

## How To Do It Better

Treat CommonJS as a first-class loader mode. One subsystem should handle
classification, wrapper execution, export-name declaration, `default`,
`module.exports`, re-export copying, and builtin facades. Use a real lexer or
Node-aligned parser strategy, and add fixtures for recursive exports, circular
requires, live bindings, getters, late mutations, and missing names.
