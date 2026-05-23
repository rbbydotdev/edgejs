# worker_threads in browser-Node runtimes — findings

Research conducted 2026-05-23. Full agent output in
`/private/tmp/claude-501/.../tasks/aa2e3edff28c34e9c.output`.

## Recommended topology: per-Worker wasm

**Each `new Worker(filename)` spawns a fresh DedicatedWorker that boots its
own edge.js wasm.** Same pattern as WebContainer.

**Don't try shared wasm.** Node's per-Worker process-state isolation
(`process.exit` only kills the Worker, separate `process.env` copies,
`process.chdir` disabled in workers, etc.) cannot be reproduced inside a
single wasm linear memory without absurd coordination logic. Per-Worker
isolate is the only viable path.

## Topology diagram

```
                      ┌─────────────────────────────┐
                      │ Main thread (page)          │
                      │  - Worker registry          │
                      │  - DedicatedWorker spawner  │
                      │  - SW bridge owner          │
                      └─────────────┬───────────────┘
                                    │
       ┌──────────────────────┬─────┴───────┬─────────────────────┐
       │                      │             │                     │
┌──────▼─────┐         ┌──────▼─────┐  ┌────▼───────┐       ┌─────▼──────┐
│ bridge-    │         │ runtime W0 │  │ runtime W1 │       │ runtime Wn │
│ worker     │         │ (isMain    │  │  (Worker)  │       │  (Worker)  │
│ (FS, SW    │         │  Thread=T) │  │            │       │            │
│  outbound) │         │ + wasi-    │  │ + wasi-    │       │ + wasi-    │
│            │         │   threads  │  │   threads  │       │   threads  │
└────────────┘         └──────────┬─┘  └──────────┬─┘       └──────────┬─┘
                              pthread          pthread               pthread
                              children         children              children
```

- Each "runtime worker" = a Node "thread" (one isMainThread, the rest aren't)
- All runtime workers share the same `bridge-worker` for FS snapshot, SW outbound, OPFS
- MessagePort between user Workers allocated on main; ports transferred to children
- wasi-threads pthread pools are PER-runtime-worker; don't conflate with `worker_threads`

## CRITICAL distinction

**emnapi wasi-threads ≠ Node worker_threads.**

- wasi-threads is C-level pthread support inside one wasm instance (shared memory). Already wired in edge.js (`thread-worker.ts`).
- `worker_threads` is user-facing Node API — needs full Worker isolation.

Don't try to reuse the pthread pool for worker_threads. Different model.

## Implementation cost

| Component | LOC estimate | Risk |
|---|---|---|
| `node-worker.ts` (Worker entry, cloned from worker.ts) | ~250 | Low |
| `host/node-worker-host.ts` (MessageChannel routing) | ~300 | Med |
| `policies/worker-threads-via-host.ts` (lib override) | ~250 | Med (EventEmitter ↔ EventTarget shim) |
| `main.ts` spawn handler (Safari nested-Worker workaround) | ~50 | Low |
| Buffer → ArrayBuffer copy on transfer | ~30 | Low (sharp edge) |
| Tests | ~300 | — |
| **Total** | **~1100 + tests** | |

Boot cost per Worker: ~150 ms after warm cache. Memory: ~64–96 MB per Worker. Pre-warm pool of 2–4 workers → spawn latency <5 ms.

## Known sharp edges

1. **Buffer in `transferList`** — wasm-aliased Buffer's underlying SAB is wasm linear memory. Transferring would neuter the wasm. **MUST copy to plain ArrayBuffer first.** Document as a known perf regression vs Node.
2. **Synchronous spawn semantic** — Node's `new Worker(...)` returns to JS only after child started enough to receive messages. Browser `new Worker()` returns immediately. **Buffer parent→child messages until child's `'online'`.** ~20 LOC. Same trick WebContainer uses.
3. **Safari nested-Worker support** — historically flaky. Spawning via main side-steps this. Main acts as the spawn registry.
4. **SharedArrayBuffer sharing** works for user-allocated SABs across DedicatedWorker boundaries. Does NOT work for `Buffer`-backed shared regions (those are wasm memory).
5. **`worker.terminate()` mid-syscall** — `Atomics.wait` is a "safe point"; DedicatedWorkers terminate at the next safe point. Verify behavior.
6. **`process.exit()` from worker** — drain pending microtasks before close to not drop in-flight messages. Patch `lib/internal/process/per_thread.js`.
7. **Bridge worker needs `release-by-owner` plumbing** — terminate must free FS slots/sockets the dead worker owned.
8. **`postMessageToThread`** — graph routing through main. Map<threadId, MessagePort>.
9. **`napi_threadsafe_function` across user Workers** — each Worker has its own napi_env; cross-Worker TSFN goes through postMessage. emnapi already implements this with `--enable-multi-threading`.

## Comparable projects' status

- **WebContainer**: supports `worker_threads` faithfully. Confirmed in issue #365.
- **Cloudflare Workers**: `enable_nodejs_worker_threads_module` is a *stub* (compat 2026-03-17). Refuses real threading for sandbox reasons.
- **Deno**: added via deno_node polyfills with Rust ops + Web Worker per Worker. Has known gaps (stdout/stderr piping, SAB transfer divergences).

## 15 must-preserve test scenarios

These define "worker_threads works":

1. Hello round-trip — user code at top of API doc; worker prints `echo: hello`
2. `isMainThread` / `threadId` correct — main=1; each child unique increment
3. `workerData` deep-cloned via structured clone
4. `SharedArrayBuffer` shared — main writes via Int32Array, worker reads same bytes; Atomics.notify wakes Atomics.wait
5. `MessageChannel` between two Workers — main creates channel, transfers port1+port2 to workers A+B; A↔B talk without main relay
6. `worker.terminate()` resolves Promise + emits `'exit'` — even if worker in busy loop or `Atomics.wait`
7. `worker.unref()` lets program exit
8. `postMessage` with `transferList: [arrayBuffer]` — sender's AB.byteLength becomes 0
9. `Buffer.from(...)` in workerData round-trips as Uint8Array (prototype loss matches Node)
10. `process.exit(N)` inside worker doesn't kill main; emits `'exit'` with code N
11. `parentPort` is null in main, MessagePort in worker
12. Errors in worker → `'error'` event on main + worker dies; page survives
13. `getEnvironmentData(k)` after `setEnvironmentData(k,v)` in main
14. `BroadcastChannel('x')` between 3 workers — all three receive each other's posts
15. **Concurrent HTTP from two workers, each `http.createServer` on different "ports"** — both reachable via SW bridge; forces bridge to route by owner-ID (real infrastructure requirement)

## Cross-origin isolation requirement

COOP `same-origin` + COEP `require-corp` (or `credentialless`) mandatory for
SAB. Edge.js already has this for wasi-threads; no new constraint.

## Skip in v1

- `resourceLimits.maxOldGenerationSizeMb` — can't reach host V8 from JS
- `getHeapSnapshot` — same
- CPU profile, inspector integration
- `process.chdir`/`setuid` in worker — throw `ERR_WORKER_UNSUPPORTED_OPERATION`

Match WebContainer's posture: throw documented errors per ARCHITECTURE.md
rule "Node-honest default."

## Sources

- [Node.js worker_threads docs](https://nodejs.org/api/worker_threads.html)
- [WebContainer Firefox port — per-Worker isolate](https://blog.stackblitz.com/posts/supporting-firefox/)
- [WebContainer API announcement — sync Worker spawn pattern](https://blog.stackblitz.com/posts/webcontainer-api-is-here/)
- [Cloudflare workers worker_threads stub flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- [Deno worker_threads API](https://docs.deno.com/api/node/worker_threads/)
- [emnapi multithreaded](https://emnapi-docs.vercel.app/reference/list.html)
- [wasi-threads spec](https://github.com/WebAssembly/wasi-threads)
- [bthreads — browser worker_threads polyfill](https://github.com/chjj/bthreads)
- [Cross-origin isolation 2026](https://uper.pl/en/blog/coop-coep-corp-cross-origin-isolation/)
