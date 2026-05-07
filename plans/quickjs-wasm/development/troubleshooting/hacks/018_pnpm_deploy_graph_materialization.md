# Hack: pnpm deploy graph materialization

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Custom package graph rewriting can drift from pnpm and bundler behavior. |

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/014_pnpm_deploy_externalized_runtime_links.md`
- `plans/quickjs-wasm/development/troubleshooting/wasmer-deploy/001_pnpm_directory_symlinks_webc.md`

## What Is The Hack

Deploy preparation scans runtime imports, materializes pnpm package links,
removes `.pnpm`, rewrites virtual-store imports, and validates a symlink-free
artifact.

## Why It Is Suspect

It is pragmatic, but it is a custom package graph transformer. It can go stale
as pnpm, framework bundlers, and package export patterns change.

## How To Do It Better

Make deploy preparation a tested graph tool with explicit inputs, outputs, and
invariants. Prefer framework or bundler output that already contains a closed
runtime graph. Validate every bare runtime import inside the final artifact with
the same resolver QuickJS uses at runtime.
