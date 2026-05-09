# Known Issue: Framework static and ad hoc server adapters

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Useful bring-up adapters exist, but framework support boundaries remain explicit. |
| **Severity** | Low | Useful for bring-up, but not a general framework integration model. |

## Current State

This is a framework deployment issue, not a QuickJS N-API compatibility file.

## Source Notes

- `plans/quickjs-wasm/development/006_framework_app_adapters.md`
- `plans/quickjs-wasm/development/007_framework_standalone_builds.md`
- `plans/quickjs-wasm/development/troubleshooting/vite-app/001_standalone_build.md`

## Known Incompatibility

Astro and Vite validation used small static or ad hoc server adapters to get
framework output running under Edge QuickJS.

## Risk

These adapters prove runtime capability, but they can bypass the actual server
semantics users expect from each framework: routing, headers, streaming, error
pages, assets, and environment handling.

## Current Status

Define supported deployment modes per framework: static assets, standalone Node
server, generated dynamic shell, or unsupported. Generate adapters as tested
build artifacts instead of hand-maintained one-offs. Add fixtures for routing,
assets, headers, streaming, error pages, and env vars under native QuickJS and
WASIX.
