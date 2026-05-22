// Facade over the emnapi runtime + core packages.
//
// Per the project rule (vendored deps behind facades): every third-party
// dep sits behind a project-owned interface, imported in exactly one
// adapter file so it's swappable.  This is THE adapter for emnapi.
//
// SCOPE
//
// Re-exports only the symbols `src/napi-host/*` actually uses:
// - `createContext` / `Context` / `Env` from `@emnapi/runtime`
// - `createNapiModule` / `NapiModule` from `@emnapi/core`
//
// Everything else in emnapi is internal to this facade.  If a future
// caller needs another symbol, add the re-export here — don't bypass
// the facade.
//
// WHY
//
// emnapi's API surface is small but load-bearing, and we expect to:
// - Vendor it locally so we can patch (NOTES.md followup #1 candidate
//   (d): expose a context-scoped microtask drain in emnapi).
// - Upgrade to v-table-mode releases (toyobayashi/emnapi PR #196,
//   real `napi_env__` struct) without rippling import changes through
//   the codebase.
// - Swap implementations entirely if upstream forks (e.g. if our patches
//   never get merged and we maintain a hard-fork).
//
// The facade makes those changes a single-file edit instead of a
// sed-across-the-tree.
//
// CURRENT BACKING
//
// Imports from `@emnapi/runtime` and `@emnapi/core` in `node_modules`
// (managed by npm).  Switching to a vendored copy is one line per
// import statement below.

export { createContext } from "@emnapi/runtime";
export type { Context, Env } from "@emnapi/runtime";

export { createNapiModule } from "@emnapi/core";
export type { NapiModule } from "@emnapi/core";
