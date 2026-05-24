# R20: emnapi multithreaded mode — can it host Node `worker_threads`?

**Date:** 2026-05-24
**Scope:** Research only.  No code changes.
**Sources:** vendored `vendor/emnapi/` (v2.x branch), emnapi-docs guide,
edgejs L9 prior art (`experiments/l9-multi-context/FINDINGS.md`,
`browser-target/src/thread-worker.ts`, `browser-target/src/worker.ts`).

## 1. What multithreaded primitives does emnapi expose?

`@emnapi/wasi-threads` is the primitive layer; `@emnapi/core` re-exports
it (`vendor/emnapi/packages/core/src/index.ts:42`).  Two classes do
almost all the work:

- **`ThreadManager`**
  (`vendor/emnapi/packages/wasi-threads/src/thread-manager.ts:97-415`).
  Pure JS pool of worker handles.  `allocateUnusedWorker()` calls the
  user-supplied `onCreateWorker` factory; `getNewWorker(sab)` hands a
  worker to the spawn path; `cleanThread()`/`returnWorkerToPool()`
  recycle.  `pthreads: Record<tid, WorkerLike>` maps tids to workers.
  Type `WorkerLike = (Worker | NodeWorker) & {__emnapi_tid,
  whenLoaded, ...}` — same class works for browser `Worker` and Node
  `worker_threads.Worker`.
- **`WASIThreads`**
  (`vendor/emnapi/packages/wasi-threads/src/wasi-threads.ts:62-332`).
  Wraps a `ThreadManager` and exposes the `wasi.thread-spawn` import.
  When wasm calls `pthread_create`, `threadSpawn` runs
  `PThread.getNewWorker()`, posts a `{type:'start', payload:{tid, arg,
  sab}}` message via `command.ts`, optionally `Atomics.wait`s on a SAB
  for thread-start.
- **`ThreadMessageHandler`**
  (`vendor/emnapi/packages/wasi-threads/src/worker.ts:22-154`).
  Child-side counterpart.  On `start` it calls
  `instance.exports.wasi_thread_start(tid, startArg)` — the WASI-threads
  ABI entry point, not napi.

**pthread_create → spawn-thread:** libc → `wasi.thread-spawn` import →
`WASIThreads.threadSpawn` → pool worker → child runs
`wasi_thread_start`.  **One pthread = one Worker** (or a reused pool
worker).

## 2. Per-thread JS context

Each child worker creates **its own `WebAssembly.Instance` against the
same `Module` and same shared `Memory`**.  Wasm globals (`__tls_base`,
table) are per-instance; linear memory + Module are shared.  The child
proxy in `proxy.ts` neuters `_start`/`_initialize` so the child only
runs the thread-entry function.

Critically: **child threads do NOT create their own emnapi `Context`**.
`createNapiModule({childThread:true})` skips `napi_register_wasm_v1`
entirely and `context` may be `undefined`.  Child workers are
emnapi-passive: they run wasm but napi calls from them are UB unless
funneled through a threadsafe-function.  There is no shared napi handle
store — the isolate + refStore live on the JS thread that owns the
Context (confirmed in `experiments/l9-multi-context/FINDINGS.md:14-21`).

`napi_value` is therefore **thread-local to the JS thread that owns the
Context**, exactly as in native Node.  Cross-thread JS interaction goes
through tsfn.

## 3. Can emnapi host Node `worker_threads.Worker`?

**The abstractions are a deliberately partial fit:**

- `onCreateWorker` accepts `worker_threads.Worker` directly.
- **But "pthread" ≠ "Node Worker."**  A pthread shares linear memory; a
  Node Worker has its own V8 isolate and only shares SABs / transferred
  ArrayBuffers.  emnapi's spawn protocol assumes shared memory + a
  single wasm Module compiled with `-pthread`.  Reusing it for
  `worker_threads` would give the child a separate isolate, separate
  emnapi Context, and **no shared napi handles**.

Message passing: `command.ts` defines
`load`/`loaded`/`start`/`cleanup-thread`/`spawn-thread`/`terminate-all-
threads`/`async-send`.  All transport is `postMessage`; SAB is used
only for `pthread_create` return-handshake and for `waitThreadStart`.

## 4. Known limitations explicitly documented

- **Browser main thread cannot block.**  `pthread_join` calls
  `Atomics.wait`, disallowed on window main thread.
- **`reuseWorker` strict mode** prevents pool-exhaustion deadlocks in
  browser.
- **SAB requires cross-origin isolation** (COEP: require-corp, COOP:
  same-origin).
- **Memory must be `shared:true`** — `checkSharedWasmMemory()` throws
  otherwise.
- **WASI pthread is browser-hostile** — multithreaded-async.md warns
  `pthread_mutex_lock` calls `memory.atomic.wait32`; recommends
  Emscripten pthread for browser.
- **`asyncWorkPoolSize ≤ reuseWorker.size`**.

## 5. Explicit recommendations from emnapi authors

There is **no published guidance from toyobayashi on implementing Node
`worker_threads`** on top of emnapi.  Docs treat Node `Worker` only as
a *transport* returned by `onCreateWorker`, not as a higher-level
concept emnapi targets.

## Recommendation for edgejs L9

For edgejs's `worker_threads` implementation, **do not layer it on top
of `WASIThreads`/`ThreadManager`** because those abstractions spawn
**pthreads** (additional wasm threads sharing one linear memory),
which edgejs already uses for the libuv thread pool.  A Node `Worker`
is the OPPOSITE: an isolated JS+wasm universe with its own napi
Context and only SAB-transferable state.

**Design Q1: intercept at JS level** — patch `lib/internal/worker.js`
via policy.  `binding_worker.cc` is V8/libuv glue with no napi
surface; no hook point.

**Design Q2: each user-spawned `Worker` gets its own host browser-
Worker hosting a fresh `createNapiModule({context: createContext(),
...})`** — new bridge pair per Worker, not shared.  emnapi Contexts
are fully isolated (l9-multi-context FINDINGS) and napi handles cannot
cross JS threads, so the bridge must be 1:1 with the Worker to keep
the napi-value namespace coherent.  The L9 multi-host spike + multi-
context probe already validated both halves; this is a *re-use* of the
per-Worker host+wasm pair pattern.

**Useful emnapi pieces in this path:**
- `command.ts` load/loaded protocol shape (the message-passing
  convention)
- `WorkerLike` typing (works for browser + Node Worker transports)
- `MessageHandler` from `@emnapi/core` for the child side

**None of `WASIThreads.threadSpawn` applies** because `worker_threads`
doesn't spawn pthreads.

## Open questions emnapi doesn't address

1. **Stdio routing** — Node Workers have their own
   `process.stdout`/`parentPort`; needs an edgejs policy.
2. **`MessagePort` transferable graph** — must emulate Node transfer-
   list semantics on top of browser `postMessage`.
3. **Per-Worker `terminate()` semantics** — emnapi's
   `terminateAllThreads` is pool-wide.
4. **Module resolution in the child** — must deliver edge's frozen
   module graph + user script via the bridge, not dynamic `require`.
5. **`worker_threads.SHARE_ENV` / `process.env`** — cross-Worker env
   visibility is Node-specific.
6. **Nested pthread spawning** — if a user Worker's wasm itself spawns
   pthreads (libuv pool), do they count toward `MessagePort` ownership?
