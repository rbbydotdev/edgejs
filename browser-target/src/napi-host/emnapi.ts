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
// (managed by npm).  Switching to a vendored copy is done at the Vite
// resolve-alias layer (`vite.config.ts`) when `EDGE_USE_VENDORED_EMNAPI=true`
// is set in the environment — no source change here needed.  The
// vendored tree lives at `vendor/emnapi/`.  See NOTES.md entry
// `vendored-emnapi-flag` for current flag-ON status.

export { createContext } from "@emnapi/runtime";
export type { Context, Env } from "@emnapi/runtime";

export { createNapiModule } from "@emnapi/core";
export type { NapiModule } from "@emnapi/core";

/** Runtime methods on `@emnapi/runtime` `Context` that exist in the
 *  shipped JS but are missing from the published `.d.ts`.  Cast a
 *  Context instance to `Context & ContextRuntimeAccess` when calling
 *  these.  Verified against `vendor/emnapi/packages/runtime/src/Context.ts`
 *  (lines 369-375 for the napi-value bridges; line 353 for getEnv).
 *
 *  Consumers: callback-dispatch.ts (R7 cbinfo synthesis) and
 *  cross-context-marshal.ts (R8 pack/unpack).  Centralized here per
 *  the project's "vendored deps behind facades" rule. */
export interface ContextRuntimeAccess {
  jsValueFromNapiValue<T = unknown>(napiValue: number | bigint): T | undefined;
  napiValueFromJsValue(value: unknown): number | bigint;
}
export interface ContextEnvLookup {
  getEnv<T = unknown>(envId: number | bigint): T | undefined;
}

// wasi-threads — implements the wasi-threads spec's host side, so the wasm's
// `wasi.thread-spawn` import is backed by a real Worker pool with per-thread
// TLS state (via __wasm_init_tls + wasi_thread_start).  Without this, every
// thread the wasm tries to spawn shares the same TLS region and __thread
// variables (errno, OpenSSL per-thread error stack, libuv thread pool state)
// collide across threads — visible as subtle race-like flakes.
//
// We use this in browser-target's worker.ts; the harness (Node) doesn't yet
// because Node already has real worker_threads.
export {
  WASIThreads,
  ThreadManager,
  ThreadMessageHandler,
} from "@emnapi/wasi-threads";
export type {
  WASIThreadsOptions,
  ThreadManagerOptions,
  ThreadMessageHandlerOptions,
  WorkerLike,
  WASIInstance,
} from "@emnapi/wasi-threads";
