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
option.  The lib-side patch calls a new wasm primitive
`unofficial_napi_spawn_node_worker(srcPath, options)` whose handler
spawns the (host+wasm) pair via the existing `spawnHostWorker()`
pattern.

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
Spec says structured-clone preserves wasm Modules (no recompile
needed).  R22 noted no project has measured this; **E24 will measure.**

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

- **Hard cap on simultaneous user Workers** — default TBD pending E24
  measurement.  R22 surveyed Emscripten projects with ~200 MB/worker;
  our wasm is 26 MB so likely 50-150 MB/worker.  Browser tab ceiling
  is ~2-4 GB.
- **`new Worker()` throws `ERR_WORKER_OUT_OF_MEMORY`** if cap reached.
- **Eager pre-warm pool**: default 0 (no pre-warm), opt-in via
  `--worker-threads-prewarm=N` policy config.

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

## What's still unknown (driving E24/E25)

- E24: per-pair memory + spawn time + WebAssembly.Module transferable
  effectiveness
- E25: whether WC's sync-spawn trick survives JSPI suspension on the
  parent

After E24/E25 land, this doc becomes the spec.  Until then it's a
sketch.

## Future work / explicit non-goals

- Cross-tab Worker sharing — out of scope
- Worker-pool optimization variant (lightweight multiplexed) —
  explicitly dropped per user direction
- Native add-on support in user Workers — N/A (we don't support native
  add-ons anywhere)
- `worker_threads.SHARE_ENV` — defer to phase 3+
