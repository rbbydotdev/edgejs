# Hack: pnpm symlink canonicalization and fs stat fallback

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Makes pnpm graphs work but spreads symlink behavior across layers. |

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/009_zustand_esm_default_export.md`
- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/012_wasix_pnpm_symlink_resolution.md`
- `plans/quickjs-wasm/development/troubleshooting/wasmer-deploy/001_pnpm_directory_symlinks_webc.md`

## What Is The Hack

QuickJS module resolution and fs stat behavior were adjusted to canonicalize
pnpm symlinked paths and retry through resolved symlink components.

## Why It Is Suspect

The behavior is needed, but it is split across resolver code, fs behavior, and
deploy packaging. That can hide differences between host filesystems, WASIX
filesystems, and materialized deploy artifacts.

## How To Do It Better

Build one realpath/symlink service shared by CJS resolution, ESM resolution, fs
bindings, and WASIX packaging checks. Add pnpm fixture tests for
dependency-scoped resolution and validate deploy artifacts with the same
resolver used at runtime.
