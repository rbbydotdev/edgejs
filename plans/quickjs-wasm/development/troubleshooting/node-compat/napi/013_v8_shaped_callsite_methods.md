# Known Issue: V8-shaped CallSite methods

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Implemented in the vendored QuickJS CallSite and raw stack trace APIs, with conservative metadata gaps. |
| **Severity** | Medium | Provides Node/V8 stack APIs over incomplete QuickJS metadata. |

## Current State

This note tracks a QuickJS engine-level structured-stack issue that supports
Node-facing diagnostics. It is not part of a removed N-API compatibility
directory.

We implemented the missing QuickJS source-level support in
`41b00d4cc34cf79188cd9255f050e95ea1a2e9d6`. That commit adds
`JS_GetCurrentStackTrace(...)`, raw stack frame objects with V8-shaped fields,
and tests for public `Error.prepareStackTrace` data-property behavior.

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

The vendored QuickJS `CallSite` prototype now exposes the Node/V8-shaped
methods needed by `depd` and Edge diagnostics. The QuickJS N-API helper
`napi_callsite__` maps `unofficial_napi_get_call_sites`,
`unofficial_napi_get_current_stack_trace`, and caller-location helpers onto
`JS_GetCurrentStackTrace(...)`.

The remaining caveat is metadata fidelity. QuickJS does not naturally track all
V8 fields, so methods such as eval origin, constructor flags, async frames, and
promise-all metadata return conservative defaults when the engine lacks the
data. Treat regressions here as diagnostics fidelity issues, not as a reason to
restore a removed compatibility directory.
