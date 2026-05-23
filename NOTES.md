# Edge.js Browser Target — NOTES

Active debts, current capability, and short-term followups. Newest at top.

For the layered architecture, design rules, and per-feature offload
catalog, see [ARCHITECTURE.md](./ARCHITECTURE.md).

For historical bug-resolution stories and the full investigation trail,
see [ARCHIVE.md](./ARCHIVE.md).

---

## Current capability

| Surface | Status | Notes |
|---|---|---|
| Boot, console.log to stdout | ✅ | `_start` runs ~130-200ms |
| `process.exit(N)` | ✅ | clean teardown |
| `setTimeout` / `setInterval` | ✅ | via `poll_oneoff` Atomics.wait |
| `Buffer.from(string)` + indexed access | ✅ | structurally wasm-aliased |
| `queueMicrotask` / Promise.then | ✅ | routed to host's native queue |
| `Response.text()` / `.arrayBuffer()` | ✅ | webstreams + crypto primordials patched |
| `http.createServer` + fetch roundtrip | ✅ | Service Worker bridge |
| `fs.readFileSync` on `/node-lib/**` + `/node/deps/**` | ✅ | bundled adapter via sync XHR |
| `fs.writeFileSync` to userland paths | ✅ | in-memory only |
| `crypto.createHash().update().digest('hex')` | ✅ | sha256 verified |
| `crypto.randomBytes(N)` / `randomUUID()` | ✅ | real entropy |
| `require('node:builtin')` (most) | ✅ | from compiled-in catalog |
| Module-source overrides | ✅ | universal (bootstrap + lazy) + `{ pre, post }` shapes |
| TLS primitives + `https.createServer.listen()` | ✅ | OpenSSL bundled |
| HTTPS server through SW bridge | ✅ | `inbound-https-via-sw` policy |
| Outbound `http.request` (mock fetch) | ✅ | `outbound-fetch-tunnel` policy |
| Outbound `http.request` (Node-honest default) | ✅ → throws | `outbound-throw` policy |
| `import` (ESM) | ❌ | `module_wrap_*` are stubs |
| OPFS persistence | ❌ | in-memory only |
| `worker_threads` | ❌ | not started |
| `child_process` | ❌ | needs subprocess model |
| Concurrent HTTP | ✅ | ring of 16 SAB slots; SW Map keyed by reqId |
| Async `fs.readFile` / `fs.writeFile` | ✅ | cross-thread SAB file table; pool workers share data region with main |
| Cross-thread pipe wakeup (`uv_async_send`) | ✅ | SAB-backed pipes; pool→main wake unblocks main's `poll_oneoff` |
| libuv thread pool init | ✅ | pre-warmed via `__attribute__((constructor))` in `libuv-wasix/src/threadpool.c` (runs inside `_start` promising frame) |

**Boot cost**: ~130-200ms `_start` + ~50ms wasm compile (cached after first run).

**Auto-prepend**: every user `-e` script gets the active policies'
`userScriptPrelude` concatenated in front. Minimum is
`try{Buffer.poolSize=0}catch{};` (from `buffer-pool-disable`). See
`browser-target/src/policies/index.ts` for the full bundle. Architecture
of policy stack is in [ARCHITECTURE.md](./ARCHITECTURE.md#active-policies).

---

## Active tech-debt catalog

Inline `#!~debt` markers point here. Resolved entries live in
[ARCHIVE.md](./ARCHIVE.md). Counts as of writing: **52 markers** across
the browser-target tree.

### Boot-blocking / correctness

- `crude-circuit-breaker` — **PARTIALLY RESOLVED** (2026-05-22).
  Replaced flat `CALL_LIMIT` with a same-symbol streak watchdog (200k
  consecutive identical wasi imports → abort).  Healthy traffic
  (varied wasi calls) doesn't trip; only genuine tight-loop spins do.
  Underlying cause of the typical spin (libuv timer polling on
  `clock_time_get`) is a separate investigation.
- `jspi-re-entry-blocks-microtasks` — when a JS-driven microtask /
  napi callback enters wasm and that wasm calls a Suspending import
  (`futex_wait` / `poll_oneoff`), there is no promising frame on the
  current call stack.  JSPI rejects Promise returns.  We fall back to
  `Atomics.wait` sync, which blocks the worker's JS thread for the
  duration (no host microtasks drain).  Almost all such waits are µs
  mutex contention from libuv `uv__work_submit`; the one known
  long-wait re-entry (libuv pool init) is pre-warmed via a constructor
  so it runs inside the outer `_start` promising frame.  Warning log
  fires on the first re-entry sync wait with timeout>100ms or
  unbounded; if you see this and the worker hangs, **fix the call
  site that drove the re-entry into a wait** (e.g. move into the
  promising path via a constructor, or refactor to not wait in
  re-entry).  Clamping the wait at the shim layer is unsafe — it
  would lie to wasm about wait completion and corrupt mutex-
  protected state.  Architectural alternative: `runtime-on-separate-
  worker` (debt below).
- `fake-fs-fallback` — `path_filestat_get` returns success for paths
  the FS doesn't recognize (kept to avoid breaking libc cwd probes).
- `dynCall-before-table-ready` — `unofficial_napi_create_env` passes
  silent no-op dispatchers for makeDynCall callbacks; emnapi finalizers
  at process exit dispatch through these and silently skip. Long-term
  fix is to wire `__indirect_function_table` from the bound instance.
- `lazy-load-from-microtask` — `BuiltinModule.compileForInternalLoader`
  invoked from a microtask continuation (post-await) returns
  non-function for lazy builtins (`internal/util/colors`,
  `internal/util/inspect`, `tty`, etc). Visible as `TypeError: fn is
  not a function` from realm.js:401 when `console.log` is first used
  inside a callback. Workaround: prelude pre-primes lazy paths by
  calling `console.log('','')` with swapped-out write functions.
  **Verified still present** after Phase B microtask rebuild — see
  `tests/js/regression-lazy-load-from-microtask.{js,skip}`. Hypothesis
  refined: root cause is in `napi_run_script` / `compileForInternalLoader`
  state, not microtask queueing.
- `microtasks-starved-by-pending-timer` — when a `setTimeout(..., N)`
  is pending, edge's wasm event loop blocks ALL microtasks until the
  timer fires. Test code avoids setTimeout watchdogs; relies on the
  test-runner's 30s subprocess timeout for genuine hangs. **Verified
  still present** after Phase B — see
  `tests/js/regression-microtask-not-starved.{js,skip}`. Hypothesis
  refined: WASI `poll_oneoff` Atomics.wait blocks the JS thread that
  would otherwise drain the host microtask queue. Fix requires either
  (a) split wasm onto a worker so host can drain, or (b) periodic
  microtask-checkpoint wakeups inside the wait loop.
- `task-queue-fallback-recursion` — **RESOLVED** by Phase B. Edge's
  C++ `TaskQueueEnqueueMicrotask` now calls
  `unofficial_napi_enqueue_microtask` (wasm import) which routes to
  host's `queueMicrotask` directly — no recursion path. The L4
  `task-queue-enqueue-fix` policy is no longer in defaults; kept in
  the registry as opt-in/diagnostic. See ARCHIVE.md for history.
- `buffer-wasm-aliased-policy-required` — the structural properties
  the new buffer model relies on (`Buffer.buffer` IS the SAB;
  byteOffset is the wasm ptr; `.length` is per-buffer) are now
  load-bearing. User code that assumes `buf.buffer instanceof
  ArrayBuffer` (vs SharedArrayBuffer), or tries to define non-Symbol
  properties on `buf.buffer`, will break. Default deployments are safe.

### Sockets / HTTP

- `single-listener` — one TCP listener at a time
- ~~`single-flight`~~ — **RESOLVED** (2026-05-22).  Bridge SAB is a
  ring of 16 atomic-claimable slots; the SW already keyed pending
  requests by reqId.  Concurrent HTTP verified end-to-end.
- `no-keep-alive` — `Connection: close` forced in request synthesizer
- `no-chunked-encoding` — auto-flush requires `Content-Length`
- `no-outbound` — `sock_connect` returns ENOSYS
- `no-socketpair` — `child_process` etc. won't work
- `no-sendfile` — `sock_send_file` returns ENOSYS
- `sw-sab-relay` — workaround for Chrome SAB/postMessage→SW incompat
- ~~`no-blocking-pipe`~~ — **RESOLVED** (2026-05-22).  Pipes are
  SAB-backed cross-thread ring buffers (`wasi-shim/pipes-sab.ts`).
  Pool worker `uv_async_send` writes the wake byte; main's
  `poll_oneoff` races a `waitAsync` on the per-pipe wake counter
  alongside the bridge wake.  Atomic head/tail; refcounted close.
- `wake-slot-collisions` — 255 conn slots max
- `fake-local-addr`, `fake-peer` — addr structs don't reflect real binding
- `no-ipv6` — sock_bind parses IPv4 only

### Filesystem

- `opfs-not-yet-persistent` — in-memory only; tab reload loses state
- `opfs-flat-store` — readdir does prefix scan, no real dir structure
- `sync-xhr-network-blocking` — bundled adapter blocks worker on cold-cache fetch.
  Mitigated for pool workers: their opens route through the SAB
  snapshot (`wasi-shim/fs-snapshot-sab.ts`); only the *loader* (main
  worker) hits the sync XHR, and pool reads are SAB-direct.
- `no-write-support` — bundled adapter is read-only (the SAB snapshot
  has its own in-memory writable layer; bundled files stay immutable).
- `no-readdir` — bundled adapter has no listing endpoint
- `naïve-stat-via-fetch` — stat via HEAD, no mtime/ctime
- `sab-fs-snapshot-bounded` (2026-05-22) — SAB-backed fs snapshot has
  fixed regions: 128 path slots, 64KB names, 256 fd slots, 24MB data.
  Each writable file pre-allocates a 1MB buffer.  Heavy module loading
  or many concurrent writable files can exhaust.  Bumping limits costs
  SAB headroom; spill-to-disk needs OPFS persistence first.
- `sab-fs-read-only-writes-not-persisted` (2026-05-22) — writable
  files in the SAB snapshot are in-memory only.  `fs.writeFile` from
  any worker is visible to subsequent reads from any worker via the
  shared SAB, but contents are lost on tab reload.  Real persistence
  needs the OPFS layer wired as a back-store for snapshot writes.

### napi / Buffer

- `namespace-default-fallbacks` — `imports-generated.ts` falls through
  to per-namespace defaults (napi=0, wasi=52). "Implemented" means
  "callable with right arity," not "semantically correct."
- `buffer-write-sync-residual` — fallback policy retained as diagnostic;
  not in defaults. Doesn't cover paths where C++ writes bypass the
  public Buffer JS API.
- Multiple `#!~debt` in `unofficial.ts` — most no-op stubs writing
  sensible defaults to out-params. Promote when a workload lights them up.

### Cross-worker primitives

- `l1-perf-variance-investigation` (L1 2026-05-23) — local
  perf-harness measurements after L1 show wasmRunMs median 200-290ms
  vs L0 baseline 129ms (60-100% slowdown).  Agent's own verification
  reported 133ms (in budget).  Contradiction; likely sources: (a)
  concurrent processes during my measurement (background agents),
  (b) Vite dev rebuild costs on first request, (c) Playwright +
  Chromium warm-up state.  totalCalls is bit-identical (14648),
  proving no extra wasm-side work — the variance is host-side, not
  wasm-side.  Investigate with: dedicated machine, no background
  load, vite production build instead of dev.  L1 ships; refactor
  is behavior-preserving and call counts deterministic.

- ~~`fs-snapshot-sab-missing-context-fields`~~ — **RESOLVED** (L1
  2026-05-23) by adding contextId + hostWorkerId fields to the
  request ring entry header (bumped 12 → 20 bytes) and threading
  them through `enqueueLoad` / `drainNext` / `PendingRequest`.
  Default 0/0 in single-host setup; ready for L9 worker_threads
  multi-host routing.

- ~~`pipes-sab-not-on-sab-ring`~~ — **RESOLVED** (L1 2026-05-23)
  for the contextId/hostWorkerId convention by adding those slot
  header fields and threading them through `allocate`.  Slot
  header is now 40 bytes (was 32).  Different shape from sab-ring's
  request/reply state machine — pipes are bidirectional streams,
  so they retain their own per-slot ring buffer logic.  The
  convention adoption is complete; the structural difference
  is intentional.

### Test infrastructure

- `vendored-emnapi-flag` (L0 2026-05-23) — `EDGE_USE_VENDORED_EMNAPI=true`
  swaps imports of `@emnapi/*` to `vendor/emnapi/packages/*/dist/*` via
  Vite alias.  Default OFF; flag mechanism works (verified by running
  test:browser under both states).  Vendored copy is v2.0.0-alpha.1
  (npm is 1.10.0) — major version delta means flag-ON currently breaks
  (15 fail).  Two fix paths when we need flag-ON to work (L5 cutover):
  (a) downgrade vendored to 1.10.x to match call-site API, or (b)
  upgrade `src/napi-host/*` to emnapi v2 API.  Defer until L5 forces
  the choice.  Vendor at `vendor/emnapi/` (161MB; full clone, no .git).
- `browser-runner-ignores-harness-args` — `browser-target/scripts/browser-test-runner.mjs`
  doesn't honor sibling `.harness-args` files the way the node-harness
  runner does. Tests that rely on per-test policy opt-in via CLI flags
  (e.g. `policy-crypto-host-random.harness-args`) won't pick up the
  right policy set when run through the browser. Map flags to URL
  params (`?policies=...` is already wired) when the first test needs
  this.

### Architectural changes shipped

- `runtime-on-separate-worker` (2026-05-22) — **SHIPPED** as commit
  `0ee83dc5`.  Emscripten `PROXY_TO_PTHREAD` analog.  Split single
  worker into two:
  - `bridge-worker.ts` — owns the layered FS adapter (bundled-fs +
    opfs) and the FS snapshot loader.  No wasm.  Its JS event loop
    stays free during a runtime worker `Atomics.wait`.
  - `worker.ts` (runtime worker) — pure wasm host + JSPI.  Attaches
    to the FS snapshot as a *reader* (its own cold-miss opens
    `Atomics.wait` on bridge to publish).
  Contains the freeze impact (a long re-entry sync wait on runtime
  doesn't stall the FS loader or pool workers) but does not eliminate
  the wait itself.  If this proves problematic for some workload (too
  many cross-worker hops, latency overhead, race surface), revert to
  the previous monolithic shape by reverting `0ee83dc5` — the commit
  is self-contained.  Trigger to keep an eye on: the
  `[bridge] [fs-snapshot] loaded …` log line should appear during
  startup and on any new path open; if it disappears, the loader
  isn't running.

### Production gaps (post-Phase-B microtask rebuild)

Real semantic differences vs Node that Phase B (wasm imports for
`unofficial_napi_*` microtask ops) did NOT close. Each needs a
deeper intervention — typically a real microtask checkpoint pump
or splitting the wasm runtime off the JS thread.

- **`WebAssembly.compile()` deadlock** — V8 needs `PumpMessageLoop` +
  microtask checkpoint to resolve the promise. No foreground task
  pump in our setup.
- **`process.on('unhandledRejection')` partially wired** — wasm
  import captures the lib handler into `MicrotaskOpsState` and
  `installHostPromiseRejectListeners` forwards host events, but lib
  defers emission via tickCallback which our runtime doesn't drive
  in the same window. Verifiable as: rejection IS captured but doesn't
  surface to user listeners before process exit.
- **WeakRef / FinalizationRegistry leaks** — `ClearKeptObjects` never
  runs (would be a side-effect of proper microtask checkpoint).
- **`process.nextTick` ordering inversion** — nextTicks go through
  edge's tickInfo/tickCallback; microtasks through host. Nested-await
  code may observe different interleaving than real Node.
- **`worker_threads.MessageChannel` would deadlock** — microtask-
  coordinated wakeups across workers need a single coordinated queue.
- **`lazy-load-from-microtask`** — see debt entry above. Regression
  test at `tests/js/regression-lazy-load-from-microtask.js`.
- **`microtasks-starved-by-pending-timer`** — see debt entry above.
  Regression test at `tests/js/regression-microtask-not-starved.js`.

---

## Active followups (priority order)

### 1. Microtask checkpoint pump (Phase B follow-up) — needs novel solution

Phase B (wasm imports for `unofficial_napi_*` ops) closed
`task-queue-fallback-recursion`, but did NOT close
`lazy-load-from-microtask` or `microtasks-starved-by-pending-timer`
(verified by `tests/js/regression-*.{js,skip}`).

**The constraint (browser target — the actual deployment shape)**:

Wasm runs inside a `DedicatedWorker`.  That worker has its own event
loop and microtask queue.  `queueMicrotask` / `Promise.then` queue
onto it; microtasks drain at TASK BOUNDARIES (after an event handler
returns, after a `postMessage` is processed, after a `setTimeout`
fires).  No browser exposes `PerformMicrotaskCheckpoint` to JS.

Edge's `_start` runs as ONE long synchronous task on the worker
thread.  It never returns to the worker's event loop, so no task
boundary fires, so microtasks never drain.  When `poll_oneoff` blocks
on `Atomics.wait`, the worker thread is stuck — microtasks couldn't
drain even in principle until that wait releases.

The fix shape: wasm has to YIELD back to the worker's event loop
periodically.  Then the loop turns, microtasks drain (including
any `await fetch(...)` / `await stream.read()` continuations), and
we resume wasm.  That's exactly what Asyncify-at-the-syscall-boundary
buys us.

**Node-harness side-note** (for diagnostic context, not the fix):
Edge's `src/edge_runtime.cc:1870` calls `unofficial_napi_process_microtasks(env)`
once per loop iteration expecting `Isolate::PerformMicrotaskCheckpoint()`.
We DO plumb Node's `process._tickCallback` through to honor that
contract (snapshot in `host/globals-shim.ts`, invoked by
`microtask-ops.ts`).  Isolated experiments
(`/tmp/microtask-drain-experiment/exp8-harness-fix-pattern.mjs`)
confirmed the drain primitive works when wasm is called from a
scope-depth-0 entry (libuv callback, `setImmediate`).  BUT inside
edge.js's full runtime, scope depth stays >= 1 throughout `_start`'s
execution because the wasm doesn't exit + re-enter Node's scope
between libuv-internal callbacks — so V8's
`MicrotasksScope::PerformCheckpoint(>0 depth)` early-returns and
the drain only fires at end-of-`_start`.  Calling _tickCallback is
still correct intent (composes when a future fix gives us
scope-depth-0 callback boundaries) but doesn't currently close the
two regression-skipped bugs.  Doesn't translate to browser anyway.
Solution has to come from the wasm-yields-to-event-loop side
(Asyncify-at-the-syscall-boundary), not the host-side-drain side.

**Real approaches:**

- **(a) Move wasm to a Worker (emnapi multithreaded mode).**  Per
  emnapi docs (https://emnapi-docs.vercel.app/guide/multithreaded-async.html):
  spawn a Worker with the wasm + napi context inside it, host JS on
  main thread.  Main thread's microtask queue drains naturally between
  postMessage volleys, and wasm-side waits use SAB-coordinated wakeups
  through the worker.  Requires emnapi vendoring + recompile of edge.js
  with pthread support, plus a substantial harness/SW restructure.
  Largest correctness win; biggest surface change.

- **(b) Syscall-level Asyncify at the wasi-shim boundary.**  When
  `poll_oneoff` is called with a timer-only subscription, the wasi-shim
  saves the wasm context, returns control to JS, `setTimeout(resume, N)`
  for the timer, microtasks drain in the gap, then we re-enter wasm on
  the timer fire.  Smaller blast radius than full Asyncify — only the
  syscall boundary yields, not arbitrary call stacks.  Requires real
  Asyncify (Emscripten compile flag) OR our own continuation primitive
  in the wasi shim.

- **(c) Full Asyncify on `_start`.**  Recompile with `-s ASYNCIFY=1`
  or equivalent for WASIX, wrap `_start` so any wasm function can
  yield to the host.  Pyodide / Emception use this.  Cost: ~20-30%
  perf overhead, +25-50% wasm binary size, unclear WASIX support.

- **(d) Expose a context-aware drain in emnapi.**  Upstream patch
  to emnapi adding `napiModule.emnapi.runMicrotasks()` that calls
  `context->GetMicrotaskQueue()->PerformCheckpoint(isolate)` on edge's
  V8 context.  Tightest fix BUT (i) requires C++ side support since
  V8 context isn't reachable from JS, and (ii) upstream coordination
  with toyobayashi/emnapi.  Probably folds into our existing emnapi
  vendoring plan (followup #4).

**Recommended order**: (d) first — investigate whether it's possible
to add a JS-callable drain in emnapi for edge's env's context.  If
upstream merges or we vendor + patch, this is the cleanest fix.
Fall back to (b) syscall-level Asyncify if (d) doesn't pan out.
(a) and (c) are heavy lifts kept for completeness.

This bug is not load-bearing for any test currently in the corpus
(the regressions are `.skip`), so it can sleep while we ship other
phases — but it gates Node-correct concurrency semantics that real
apps depend on (Promise.then before timer, await before timer).

### 2. Offload policies (Phase C in the architecture plan)

**Blocked-by-#1**: every host-async policy (compression, crypto-via-subtle,
wasm-compile-via-host, streams) needs Promise continuations to resolve
inside edge's context — see #1 for why this currently doesn't work.

`compression-via-compressionstream` is shipped as a spec / reference
(in `src/policies/`, registered as opt-in) but does NOT execute its
callback today — kept so the fix path for #1 can validate against a
concrete consumer.  Test deferred until #1 lands.

Synchronous offloads (crypto random was the first) are NOT blocked
and remain a fine direction independent of #1.

- `crypto-via-subtle` — `crypto.createHash` / `Hmac` / `pbkdf2` /
  `randomBytes` route to SubtleCrypto. ~80% smaller crypto surface.
  Mostly async — blocked by #1 except for sync helpers.
- `compression-via-compressionstream` — gzip/deflate → browser's
  CompressionStream / DecompressionStream.
- `streams-via-web-streams` — Node Readable/Writable adapter to/from
  Web Streams for interop.
- `wasm-compile-via-host` — route edge's `WebAssembly.compile` to host's.

### 3. ESM support (`module_wrap_*`)

18 `module_wrap_*` impls are stubs. Real Node `import` syntax fails at
link/evaluate. Probably needs Asyncify to bridge browser's async
`import()` to sync wasm. 600-1500 LOC.

### 4. Adopt emnapi v-table mode

Vendor emnapi locally. Upgrade to a release that includes PRs #195/#196
(real `napi_env__` C struct with vtable pointers). Move L3 intercepts
into vtable entries. Future-proof against the napi-env-struct evolution.

### 5. OPFS persistence

User has said save for last. Replace in-memory writable layer with
`FileSystemSyncAccessHandle` backed storage. Async pre-warm phase
for directory handles.

### 6. `worker_threads`

Each worker = real Web Worker with shared memory. Bridge `postMessage`
to our SAB transport. Blocked on #1 (microtask queue must coordinate).

### 7. Memory hygiene

Buffers we `_malloc` are never `_free`'d. Long-running apps OOM. Need
FinalizationRegistry or explicit lifetime tracking.

---

## Tools / inventory

- `browser-target/src/wasi-shim.ts` — WASI + WASIX syscalls (~1400 LOC)
- `browser-target/src/napi-host/` — emnapi composition + 80 unofficial_napi_*
- `browser-target/src/host/fs/` — FileSystem facade + 3 adapters
- `browser-target/scripts/node-harness.mjs` — Node-side test loop
- `browser-target/scripts/test-runner.mjs` — regression net (`tests/js/*.js`)
- `tests/js/*.js` + `*.stdout`/`*.stderr`/`*.skip`/`*.harness-args` — corpus
- `browser-target/src/overrides/https-as-http.ts` — server-side https→http
- `browser-target/src/policies/*.ts` — deployment-time strategies
- `browser-target/public/edgejs.wasm` — 26.5MB build artifact (gitignored)
- `patches/napi/*.patch` — local mods to napi/ submodule
- `scripts/setup-napi-patches.sh` — applies the patches on fresh checkout
- [ARCHITECTURE.md](./ARCHITECTURE.md) — layered model + offload catalog
- [ARCHIVE.md](./ARCHIVE.md) — full history, resolved bugs, prior debt
