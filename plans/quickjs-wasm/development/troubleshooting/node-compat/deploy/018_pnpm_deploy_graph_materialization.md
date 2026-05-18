# Known Issue: pnpm deploy graph materialization

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Deploy graph materialization exists, with drift risk against pnpm and bundlers. |
| **Severity** | Medium | Custom package graph rewriting can drift from pnpm and bundler behavior. |

## Current State

This is a deployment artifact issue, not a QuickJS N-API compatibility file.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/014_pnpm_deploy_externalized_runtime_links.md`
- `plans/quickjs-wasm/development/troubleshooting/wasmer-deploy/001_pnpm_directory_symlinks_webc.md`

## Known Incompatibility

Deploy preparation scans runtime imports, materializes pnpm package links,
removes `.pnpm`, rewrites virtual-store imports, and validates a symlink-free
artifact.

## Risk

It is pragmatic, but it is a custom package graph transformer. It can go stale
as pnpm, framework bundlers, and package export patterns change.

## Current Status

Make deploy preparation a tested graph tool with explicit inputs, outputs, and
invariants. Prefer framework or bundler output that already contains a closed
runtime graph. Validate every bare runtime import inside the final artifact with
the same resolver QuickJS uses at runtime.
