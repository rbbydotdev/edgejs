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
| Concurrent HTTP | ⚠️ | single-flight per-SW |

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

- `crude-circuit-breaker` — `CALL_LIMIT = 20000` in worker.ts. Real fix:
  watchdog timer on progress, not call count.
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
- `single-flight` — one inflight HTTP request per Service Worker
- `no-keep-alive` — `Connection: close` forced in request synthesizer
- `no-chunked-encoding` — auto-flush requires `Content-Length`
- `no-outbound` — `sock_connect` returns ENOSYS
- `no-socketpair` — `child_process` etc. won't work
- `no-sendfile` — `sock_send_file` returns ENOSYS
- `sw-sab-relay` — workaround for Chrome SAB/postMessage→SW incompat
- `no-blocking-pipe` — `fd_pipe` reader-before-writer returns EAGAIN
- `wake-slot-collisions` — 255 conn slots max
- `fake-local-addr`, `fake-peer` — addr structs don't reflect real binding
- `no-ipv6` — sock_bind parses IPv4 only

### Filesystem

- `opfs-not-yet-persistent` — in-memory only; tab reload loses state
- `opfs-flat-store` — readdir does prefix scan, no real dir structure
- `sync-xhr-network-blocking` — bundled adapter blocks worker on cold-cache fetch
- `no-write-support` — bundled adapter is read-only
- `no-readdir` — bundled adapter has no listing endpoint
- `naïve-stat-via-fetch` — stat via HEAD, no mtime/ctime

### napi / Buffer

- `namespace-default-fallbacks` — `imports-generated.ts` falls through
  to per-namespace defaults (napi=0, wasi=52). "Implemented" means
  "callable with right arity," not "semantically correct."
- `buffer-write-sync-residual` — fallback policy retained as diagnostic;
  not in defaults. Doesn't cover paths where C++ writes bypass the
  public Buffer JS API.
- Multiple `#!~debt` in `unofficial.ts` — most no-op stubs writing
  sensible defaults to out-params. Promote when a workload lights them up.

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

**The constraint**: in JS, the microtask queue only drains when control
returns to the event loop.  When edge's wasi shim handles `poll_oneoff`
with a timer subscription, it calls `Atomics.wait` to block until the
timer fires.  `Atomics.wait` is synchronous — it blocks the JS thread
that the wasm + edge's V8 context BOTH run on.  No event-loop turn,
no microtask drain.  Splitting wasm to another worker doesn't help:
user JS executes inside edge's V8 context, which lives on whichever
thread runs the wasm — so the user's `Promise.then` callback is queued
on the blocked thread regardless.  Looping shorter `Atomics.wait`s
doesn't help either, since synchronous code between iterations doesn't
yield to the event loop.

**Two real approaches:**

- **(a) Syscall-level Asyncify at the wasi-shim boundary.**  When
  `poll_oneoff` is called with a timer-only subscription (no fd events),
  the wasi-shim saves the wasm context, returns control to JS,
  `setTimeout(resume, N)` for the timer, microtasks drain naturally
  during the gap, then we re-enter wasm on the timer fire.  Smaller
  blast radius than full Asyncify — only the syscall boundary needs to
  yield, not arbitrary call stacks.  Implementation cost: moderate.
  Performance cost: at most one event-loop hop per timer-only wait.
  Requires either real Asyncify (Emscripten compile flag) OR our own
  continuation primitive (probably an indirect-call resumption table
  built into the wasi shim).

- **(b) Full Asyncify on `_start`.**  Recompile with `-s ASYNCIFY=1`
  or equivalent for WASIX, wrap `_start` so any wasm function can
  yield to the host.  Pyodide / Emception use this.  Cost: ~20-30%
  perf overhead, +25-50% wasm binary size, unclear WASIX support.
  Largest blast radius — every wasm function becomes potentially
  reentrant.  Strictly more capable than (a) but more invasive.

**Recommended first step**: investigate (a) — verify wasi-shim can
intercept timer-only `poll_oneoff`, prove the resumption primitive
works on a toy wasm, then graft into the edge.js shim.  Only fall
back to (b) if (a) hits a fundamental wall.

This bug is not load-bearing for any test currently in the corpus
(the regressions are `.skip`), so it can sleep while we ship other
phases — but it gates Node-correct concurrency semantics that real
apps depend on (Promise.then before timer, await before timer).

### 2. Offload policies (Phase C in the architecture plan)

Independent of #1. Each is a swappable plug-in:

- `crypto-via-subtle` — `crypto.createHash` / `Hmac` / `pbkdf2` /
  `randomBytes` route to SubtleCrypto. ~80% smaller crypto surface.
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
