# worker_threads design — edgejs browser target

Synthesizes the research from R20 (emnapi), R21 (WebContainer), and
R22 (other wasm-runtime projects).  Captures the design space and the
decisions taken before phase 1 implementation.

**Cross-references:**
- `experiments/r20-emnapi-multithreaded/FINDINGS.md`
- `experiments/r21-webcontainer-arch/FINDINGS.md`
- `experiments/r22-wasm-worker-patterns/FINDINGS.md`
- `experiments/e24-spawn-cost/FINDINGS.md` (pending)
- `experiments/e25-sync-spawn-jspi/FINDINGS.md` (pending)
- `plans/lever-b.md` — original Lever B plan
- `experiments/l9-multi-context/FINDINGS.md` — multi-host pair validation

---

## The problem

Node's `worker_threads.Worker` is a heavyweight isolated-execution
primitive.  Each Node Worker has its own V8 isolate, its own
`process.env`, its own event loop.  Communication is via structured-
clone `postMessage` and SAB.

We need to support this on the browser target where:
- We have a single browser tab
- The page hosts the main thread (router only)
- One (host+wasm) pair runs the current edge.js instance
- COOP/COEP is required for SAB

## What we are NOT doing (rejected during research)

- ❌ **Throw `ERR_BROWSER_NO_WORKER_THREADS`** — workers are too widely
  used in real Node code; not viable.
- ❌ **Multiplex user Workers onto a shared pool** — would break
  Node's per-Worker-isolate semantics; lightweight optimization
  rejected by user direction.
- ❌ **Layer on emnapi's `WASIThreads` / `ThreadManager`** — those are
  for pthreads (additional wasm threads sharing linear memory).  Node
  `Worker` is the opposite: separate isolate + separate emnapi Context
  + only SAB-transferable state.  (R20 disambiguation.)
- ❌ **Tunnel through one shared host+wasm pair with multiplexed
  contexts** — emnapi handles are thread-local to the JS thread that
  owns the Context; cannot share across user Workers.

## What we ARE doing (architecture)

```
┌─────────────────────────────────────────────────────────┐
│ Main thread (page)                                      │
│ ├── L9-validated multi-host worker registry             │
│ ├── MessagePort routing between user Workers            │
│ ├── Pool cap enforcement (memory ceiling)               │
│ └── Bridge worker (one, shared by ALL user Workers      │
│     via FS-snapshot SAB — R21 confirmed pattern)        │
└─────────────────────────────────────────────────────────┘
        │
        │ each `new Worker(filename)` spawns one user-Worker pair:
        ▼
┌─────────────────────────────────────────────────────────┐
│ User Worker N: host browser worker                      │
│ ├── Own emnapi Context (isolated handle store)          │
│ ├── Own SAB-RPC channels to its wasm runtime            │
│ └── parentPort connection (SAB-mailbox + structured     │
│     clone via extended cross-context-marshal.ts)        │
└─────────────────────────────────────────────────────────┘
        │
        │ each user-Worker host worker spawns:
        ▼
┌─────────────────────────────────────────────────────────┐
│ User Worker N: wasm runtime worker                      │
│ ├── WebAssembly.Instance (own table + globals)          │
│ ├── Shared compiled WebAssembly.Module (postMessage     │
│     transferable — R22)                                 │
│ ├── Own linear memory (NOT shared with main pair)       │
│ └── Shared SAB for cross-Worker FS state (R21)          │
└─────────────────────────────────────────────────────────┘
```

**Key shape:** N user Workers → N (host+wasm) pairs, plus the main
pair, plus one shared bridge worker.

## Design decisions resolved

### Where to intercept `new Worker(filename)`

**Patch `lib/internal/worker.js` via a policy** (`worker-threads-
per-thread.ts`).  R20 found that `binding_worker.cc` is V8/libuv glue
with no napi surface; intercepting at the binding layer isn't an
option.

### How the lib patch reaches the host (Path B chosen 2026-05-24)

Two integration mechanisms were considered.  Phase 1 ships **Path B**.

- **Path A (wasm primitive)**: add `unofficial_napi_spawn_node_worker`
  as a napi extern (declared in `napi/include/unofficial_napi.h`, stub
  in `napi/v8/src/unofficial_napi.cc`), expose it to JS via a new
  `internalBinding('worker')` binding (~100 LOC C++ scaffolding), wasm
  imports it and routes to a JS handler in
  `browser-target/src/napi-host/`.  Thematically aligned with the
  isolate-lifecycle primitives (`unofficial_napi_create_env` /
  `unofficial_napi_release_env`).  Slots cleanly into a hypothetical
  future v-table mode (NOTES followup #4).

- **Path B (globalThis-sync, CHOSEN)**: bootstrap registers a
  `globalThis.__edgeSpawnNodeWorker(srcPath, workerData) → workerId`
  function in the wasm runtime worker's V8 realm (same pattern as
  `installHostDigestSyncGlobal` for E18, `installHostHmacSyncGlobal`
  for E21).  The function does a sync RPC via `hostRpcSyncClient.
  callSync(OP_SPAWN_USER_WORKER, ...)` which parks the wasm thread on
  Atomics.wait until the host returns the assigned workerId.  Lib's
  patched `worker.js` calls this global directly.

Rationale for Path B:
- Matches the established offload pattern (E18/E21/E22): one less
  thing for future developers to learn.
- ~300-400 LOC lighter across phases 1-5 (no C++ binding scaffolding
  per new primitive).
- Memory and performance equivalent (sub-µs / sub-KB differences).
- v-table mode is hypothetical (followup #4, uncommitted); paying
  Path A scaffolding cost now would be premature.

Switch to Path A if:
- We commit to v-table mode (followup #4).
- We need spawn to be callable from C++ paths inside edge.js (not just
  from lib's JS).
- The cumulative phases-1-5 globalThis surface grows uncomfortably
  large (currently ~5-7 functions; not a concern yet).
- Cross-engine work surfaces a JS-realm peculiarity that makes the
  globalThis approach fragile.

**Gotcha to remember for Path B**: globalThis must be registered in
EVERY wasm runtime worker, including child workers (so user code in a
child can `new Worker()` to spawn a grandchild).  The
`installSpawnNodeWorkerGlobal()` call lives in `worker.ts`, which is
the same code each wasm runtime runs, so it propagates automatically
— but the property has to be consciously preserved.

### How to fake Node's synchronous `new Worker()` API

**Steal WebContainer's trick** (R21): pre-queue all bootstrap
messages BEFORE the parent enters any blocking wait.  When the child
Worker's event loop turns, it consumes them in arrival order.

Node code looks like:
```js
const w = new Worker('child.js');  // returns sync
w.postMessage({hello: 1});         // sync OK
// parent might block somewhere next
```

Our shim:
1. Spawn browser Worker (returns immediately, no setup yet)
2. Post bootstrap message: `{ srcPath, options, initialBuf }`
3. Post any user `w.postMessage()` calls
4. Return Worker handle to user

When the child Worker actually boots, it processes the queued
bootstrap, loads the file, then user messages.

**E25 confirmed (2026-05-24)**: the trick works under JSPI.  Child
Worker's event loop runs concurrently with parent's JSPI-suspended
wasm; pre-queued bootstrap messages reach the child during parent's
suspend window.  Sentinel-arrival gap on parent is ~0.06ms after
JSPI resume.  See `experiments/e25-sync-spawn-jspi/FINDINGS.md`.

### How to share the compiled wasm Module

**Compile once in main thread, postMessage the `WebAssembly.Module`
to each user-Worker's runtime worker as a structured-clone payload.**

**E24 measured (2026-05-24)**: shared-Module via postMessage works
perfectly.  Child-side compile time drops from ~22ms to 0ms.
Per-pair boot drops ~2× (50-65ms → 25-35ms steady state).  Per-pair
memory drops from ~52-72 MB to ~22 MB (only linear memory, compiled
code shared).  **This is mandatory in v1.**  See
`experiments/e24-spawn-cost/FINDINGS.md`.

### How to share the filesystem across user Workers

**One SAB-backed FS snapshot, shared across all (host+wasm) pairs via
the bridge worker.**  R21 confirmed this is exactly WebContainer's
pattern.  Our bridge worker already manages the FS snapshot SAB; we
extend it to hand the same SAB to each new user Worker's wasi-shim.

### Per-Worker isolation guarantees

- Each user Worker has its own emnapi Context (R20: napi handles are
  thread-local to the JS thread owning the Context).
- Each user Worker has its own JS realm (R21: standard browser Worker
  semantics).
- Each user Worker has its own `process.env` (Node requirement; needs
  custom impl since Node's SHARE_ENV is opt-in).
- Each user Worker has its own libuv event loop (the wasm side gets a
  fresh `_start` call).

### Resource limits

E24 measurements drive these defaults:

- **Hard cap on simultaneous user Workers: 16** (configurable).
  Matches `os.cpus().length`-ish heuristic.  Estimated ceiling per
  Chromium tab is ~80-100 pairs (per E24 trend extrapolation); 16
  leaves comfortable headroom.
- **Per-pair memory: ~22 MB** (linear memory; compiled code shared
  per E24).
- **`new Worker()` throws `ERR_WORKER_OUT_OF_MEMORY`** if cap reached
  — clear error rather than silent OOM.
- **Eager pre-warm pool**: default 0 (no pre-warm); E24 measured
  25-35 ms steady-state lazy spawn, comparable to Node native
  `Worker.online` (~10-30 ms).  Pre-warm wastes ~22 MB SAB per
  unused pair.  Opt-in via policy config if a deployment needs it.

### MessagePort transferable semantics

- Use our existing `cross-context-marshal.ts` (E16-extended for
  Map/Set/RegExp) as the structured-clone implementation.
- `MessagePort` transferable is its own primitive — for v1, ports
  transit via main-thread router; v2 could optimize to direct
  Worker↔Worker postMessage when both Workers are in the same tab.

### Refs / lifecycle (anti-pattern warning from R21)

**Don't hand-roll JS-side ref/unref bookkeeping.**  WebContainer
issue #365 documents bugs from this.  Wire `worker.ref()` /
`worker.unref()` into the same loop primitives that drive libuv
timers/IO.

### Browser engine portability

- **Chromium-first** for v1.  COOP/COEP + JSPI both ship.
- Firefox / Safari support is deferred (R21 noted SpiderMonkey atomics
  codegen on Apple Silicon causes real issues).
- The architecture doesn't preclude later cross-engine support, but
  v1 doesn't validate.

## Phase plan

| Phase | Scope | Validated by |
|---|---|---|
| 1. Spawn + RPC plumbing | `new Worker(filename)` spawns pair; child runs file; `exit` event fires | E24 (cost), E25 (sync trick) |
| 2. parentPort + postMessage | SAB-mailbox + structured-clone marshal | E16 marshal already proven |
| 3. Lifecycle | `worker.terminate()`, error propagation, exit codes, ref/unref | — |
| 4. MessageChannel + transferables | `new MessageChannel()`, port.postMessage with transfer list | E16 marshal extended |
| 5. Test corpus | Real Node worker_threads tests | suite |

**Phase 5 is just-in-time** — picks tests as they come, doesn't
require completion to ship phases 1-4.

## Phase 1 readiness — E24 + E25 both green

Both experiments have landed.  Findings:

- **E24** (spawn cost): shared-Module postMessage works perfectly;
  ~22 MB / 25-35 ms per pair; supports ~80-100 pairs / tab.  Default
  cap 16.  Mandatory shared-Module path.
- **E25** (sync-spawn under JSPI): WC's pre-queue-bootstrap trick
  works.  Synchronous `new Worker()` API achievable.  Sibling Workers'
  event loops run during parent JSPI suspend.

**This doc is now the spec for phase 1 implementation.**  No
remaining unknowns block scoping.

Remaining open questions (NOT phase-1-blocking):
- Cross-engine compat (SpiderMonkey/WebKit atomics codegen — R21
  flagged)
- Spawning a Worker from inside an already-JSPI-suspended callback
  (E25 tested spawn-before-suspend; assumed to work, unmeasured)
- Real edge.js `_start` bootstrap timing per pair (probe used minimal
  stub; ~100-300ms expected, additive to E24's numbers)

## Future work / explicit non-goals

- Cross-tab Worker sharing — out of scope
- Worker-pool optimization variant (lightweight multiplexed) —
  explicitly dropped per user direction
- Native add-on support in user Workers — N/A (we don't support native
  add-ons anywhere)
- `worker_threads.SHARE_ENV` — defer to phase 3+
