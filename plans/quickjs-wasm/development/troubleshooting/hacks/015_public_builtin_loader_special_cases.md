# Hack: Public builtin loader special cases

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Special-cased builtins make module behavior hard to reason about. |

## Source Notes

- `plans/quickjs-wasm/development/dev_001_pr_cleanup_containment/002_native_inspector_fallback.md`
- `plans/quickjs-wasm/development/troubleshooting/node-test/003_node_test_public_api_exports.md`

## What Is The Hack

The module loader special-cases public `inspector` imports, and current Node
test failures show missing builtin ESM export declarations such as `describe`
from `node:test`.

## Why It Is Suspect

Every builtin-specific branch makes the loader less predictable. Builtins need
consistent behavior across `require("x")`, `require("node:x")`, ESM imports,
named exports, categories, lazy initialization, and unsupported-feature policy.

## How To Do It Better

Build a builtin registry with CJS id, `node:` id, category metadata, public ESM
names, lazy init, and capability status. Generate require and ESM facade
behavior from that registry, then test all import forms for every exposed
builtin.
