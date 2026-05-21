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
  calling `console.log('','')` with swapped-out write functions. Root
  cause likely in napi state lifetime across microtask boundaries —
  may be resolved when we adopt a proper coordinated microtask queue.
- `microtasks-starved-by-pending-timer` — when a `setTimeout(..., N)`
  is pending, edge's wasm event loop blocks ALL microtasks until the
  timer fires. Test code avoids setTimeout watchdogs; relies on the
  test-runner's 30s subprocess timeout for genuine hangs. Root cause
  likely in `poll_oneoff` waiting on timers before draining JS tasks.
- `task-queue-fallback-recursion` — edge's C++ `TaskQueueEnqueueMicrotask`
  fallback calls `globalThis.queueMicrotask` (= lib's wrapper that
  calls this very binding). Mitigated by:
  - L3: `installTaskQueueEnqueueShim` (napi-host intercept).
  - L4: `task-queue-enqueue-fix` policy (redundant safety net).
  - **Proper fix**: rebuild edge.js with `__attribute__((used))` on
    the DCE'd `unofficial_napi_enqueue_microtask` declaration so it
    becomes a real wasm import we can implement. Pending.
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

### Production gaps (post-microtask-shim)

These are real semantic differences vs Node that the current shim
doesn't fully address. Each waits on either a wasm rebuild + real
napi imports for `unofficial_napi_*` microtask ops, or a deeper L3
intercept layer:

- **`WebAssembly.compile()` deadlock** — V8 needs `PumpMessageLoop` +
  microtask checkpoint to resolve the promise. No foreground task
  pump in our setup.
- **`process.on('unhandledRejection')` partially wired** — L3 intercept
  captures the lib handler and forwards host events, but lib defers
  emission via tickCallback which our runtime doesn't drive in the
  same window. Verifiable as: rejection IS captured by L3 but doesn't
  surface to user listeners before process exit.
- **WeakRef / FinalizationRegistry leaks** — `ClearKeptObjects` never
  runs (would be a side-effect of proper microtask checkpoint).
- **`process.nextTick` ordering inversion** — nextTicks go through
  edge's tickInfo/tickCallback; microtasks through host. Nested-await
  code may observe different interleaving than real Node.
- **`worker_threads.MessageChannel` would deadlock** — microtask-
  coordinated wakeups across workers need a single coordinated queue.

---

## Active followups (priority order)

### 1. Rebuild edge.js with proper microtask napi imports

Patch `napi/include/unofficial_napi.h` to add `__attribute__((used))`
on `unofficial_napi_enqueue_microtask`, `unofficial_napi_process_microtasks`,
`unofficial_napi_set_promise_reject_callback`, `unofficial_napi_set_promise_hooks`.

Rebuild via `make build-wasix` (wasixcc + setup-wasix-deps + CMake).
Verify the symbols appear in the wasm imports list.

Implement them host-side with a real coordinated queue. Drop the L3
shims (`installTaskQueueEnqueueShim`) and the L4 `task-queue-enqueue-fix`
policy. The L1 imports become the authoritative path.

Closes: `task-queue-fallback-recursion`, likely closes
`lazy-load-from-microtask` and `microtasks-starved-by-pending-timer`.

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
