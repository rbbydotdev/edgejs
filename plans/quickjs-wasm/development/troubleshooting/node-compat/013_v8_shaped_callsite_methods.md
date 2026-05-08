# Compatibility Adapter: V8-shaped CallSite methods

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Provides Node/V8 stack APIs over incomplete QuickJS metadata. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/002_depd_callsite_methods.md`
- `plans/quickjs-wasm/development/002_native_bootstrap_contextify.md`

## What Is The Compatibility Adapter

QuickJS stack construction honors public `Error.prepareStackTrace`, and native
`CallSite` objects expose Node/V8-style methods needed by packages such as
`depd`.

## Why It Is Suspect

V8 CallSite is not a JavaScript standard. QuickJS does not naturally track all
the same metadata, so some methods are approximations or conservative defaults.

## How To Do It Better

Define a QuickJS structured stack frame model with explicit available and
unavailable fields. Map that model to Node/V8 CallSite methods in one
compatibility layer. Test filenames, eval origins, constructor/method flags,
async frames, and missing metadata.
