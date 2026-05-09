# Known Issue: V8-shaped CallSite methods

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open structured-stack issue. |
| **Severity** | Medium | Provides Node/V8 stack APIs over incomplete QuickJS metadata. |

## Current State

This note tracks a QuickJS engine-level structured-stack issue that supports
Node-facing diagnostics. It is not part of a removed N-API compatibility
directory.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/002_depd_callsite_methods.md`
- `plans/quickjs-wasm/development/002_native_bootstrap_contextify.md`

## Known Incompatibility

QuickJS stack construction honors public `Error.prepareStackTrace`, and native
`CallSite` objects expose Node/V8-style methods needed by packages such as
`depd`.

## Risk

V8 CallSite is not a JavaScript standard. QuickJS does not naturally track all
the same metadata, so some methods are approximations or conservative defaults.

## Current Status

Define a QuickJS structured stack frame model with explicit available and
unavailable fields. Map that model to Node/V8 CallSite methods in one focused
diagnostics layer. Test filenames, eval origins, constructor/method flags, async
frames, and missing metadata.
