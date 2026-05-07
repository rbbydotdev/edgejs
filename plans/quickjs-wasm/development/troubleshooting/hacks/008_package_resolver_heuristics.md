# Hack: Package resolver heuristics

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | High | Tiny resolver differences can pick the wrong runtime file. |

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/006_floating_ui_utils_dom.md`
- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/007_react_remove_scroll_bar_constants.md`
- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/008_zustand_ind_create_export.md`
- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/010_use_gesture_controller_export.md`
- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/013_lucide_react_chevrondown_export.md`

## What Is The Hack

The QuickJS resolver learned a stack of narrow package fixes: skip `types`,
inspect subpath-directory `package.json`, support simple wildcard exports,
prefer `import` / `module` / `default`, and parse metadata to avoid false ESM
classification.

## Why It Is Suspect

Each fix was reasonable in isolation, but together they form a hand-built Node
and package-manager resolver. That is too subtle to grow by app failures alone.

## How To Do It Better

Create one owned resolver subsystem with a package metadata cache, separate
CommonJS and ESM algorithms, and fixture coverage from the real packages that
exposed failures. Compare decisions against native Node for both `require()`
and `import()`.
