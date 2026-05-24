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
| `worker_threads` | 🟡 phase 1+2 | `new Worker()` + `exit` (phase 1) + `worker.postMessage` / `parentPort.postMessage` (phase 2).  terminate / error event / workerData exposure / MessageChannel are phase 3+.  See [docs/worker-threads-design.md](./docs/worker-threads-design.md) |
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

**Host-RPC tier status (2026-05-24, post-F-9 + E5/E6/E7):**
All 106 napi op handlers exist on the host worker
(`browser-target/src/host-worker/`) and pass the F-9 sweep probe
(29/30; only pre-existing `create_external_arraybuffer` arg-validity
gap).  The wasm-side intercept layer that would route real edge.js
code through these handlers is **NOT wired** —
`grep OP_NAPI_ browser-target/src/napi-host/` returns zero hits.  The
tier is functionally complete, unit-verified, and currently unused
by any real workload.  Three experiments (E5/E6/E7) quantified the
cost of cutting it over:

- **E5** ([FINDINGS](experiments/e5-callback-triage-observation/FINDINGS.md)):
  callback-fire distribution under the test suite is bootstrap-
  dominated; hot-path candidates per the F-9 plan (stream `_read`,
  llhttp parser) fire ZERO times.  No defensible production allow-
  list without sustained-load measurement (E8 candidate).
- **E6** ([FINDINGS](experiments/e6-wasm-side-forwarding/FINDINGS.md)):
  Pattern B (Proxy on `napi.imports`) wins; cost is uniform ~20 µs
  RPC plumbing per call (40-55× in-process).  Naive forwarding is
  prohibitive (~600 ms added to `_start`).  Ship gated by
  `forwardedNapiOps: Set<string>` default-empty.
- **E7** ([FINDINGS](experiments/e7-scope-discipline-observation/FINDINGS.md)):
  edge.js never opens scopes from the wasm side; the original
  "forward `napi_open/close_handle_scope`" plan is a no-op.  Root-
  scope rotation at quiescence is the right pattern for the
  `host-emnapi-root-scope-accumulates` debt.

**Net posture:** the host-RPC tier is held in reserve as
infrastructure for a future deployment that explicitly needs it
(multi-context isolation, security boundary, hot-swap engine).
Don't ship the wasm-side intercept until a concrete motivation
appears; the test suite already works end-to-end via the existing
in-process path.

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
- ~~`microtasks-starved-by-pending-timer`~~ — **RESOLVED** by Lever B
  F-6 (2026-05-23).  Root cause as predicted: wasm worker's JSPI
  suspension (during `poll_oneoff` Atomics.wait) starved the worker's
  microtask queue.  Fix took option (a): user scripts run on a
  separate host worker whose V8 isn't JSPI-suspended.  See
  `plans/lever-b-progress.md` "F-6: user-script execution on host
  worker" + tests that un-skipped:
  `microtask-before-timer`, `nexttick-before-microtask`,
  `promise-chain-drains-fully`, `queuemicrotask-orders-with-promise`,
  `regression-microtask-not-starved`,
  `regression-lazy-load-from-microtask`,
  `await-resumes-as-microtask` — all routed via `?host=1` (sidecar
  `.harness-args` per test).  In-process wasm path retained for tests
  that need edge's lib/*.js globals (`process`, `fs`, `require`...);
  flipping that default is a future phase.
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
- `fs-write-not-visible-to-read` (2026-05-23, F-8) — `fs.writeFileSync`
  to `/tmp/*` returns successfully and `fs.existsSync` confirms the
  file, but a subsequent `fs.readFileSync` / `fs.readFile` on the
  same path returns ENOENT.  The writable layer that backs the write
  isn't consulted by the read paths.  Reproducer at
  `tests/js/fs-readfile-self.{js,skip}`.  Suggests adapter-layering
  bug between the in-memory writable layer (opfs.ts) and the read
  adapters; unrelated to Lever B.

### napi / Buffer

- `namespace-default-fallbacks` — `imports-generated.ts` falls through
  to per-namespace defaults (napi=0, wasi=52). "Implemented" means
  "callable with right arity," not "semantically correct."
- `buffer-write-sync-residual` — fallback policy retained as diagnostic;
  not in defaults. Doesn't cover paths where C++ writes bypass the
  public Buffer JS API.
- Multiple `#!~debt` in `unofficial.ts` — most no-op stubs writing
  sensible defaults to out-params. Promote when a workload lights them up.
- `host-emnapi-root-scope-accumulates` (2026-05-24, F-9 R9 fix) —
  host-worker.ts opens one long-lived emnapi handle scope at init via
  `napi_open_handle_scope`, never closes it.  Required because emnapi
  v1.10's `napiModule.init()` opens then closes its internal scope,
  leaving the root scope with `handleStore=null` — handle-allocating
  napi ops would throw on `handleStore.push`.  Side effect: handles
  allocated by host-RPC ops accumulate for the host worker's lifetime.

  Investigation 2026-05-24: a naive per-RPC open/close inside each
  napi-op-handlers.ts factory breaks the cross-RPC handle persistence
  pattern that the sweep probe (and any real caller) depends on.
  `HandleScope.dispose` → `HandleStore.erase(start, end)` calls
  `values[i].dispose()` on every slot, setting `value = undefined`;
  any subsequent RPC that references those handle ids deref's to
  `undefined`.  emnapi-runtime/dist/emnapi.cjs.js:262-268.

  E7 measurement (2026-05-24,
  experiments/e7-scope-discipline-observation/FINDINGS.md) flipped
  the original "forward wasm-side scope ops" plan: edge.js never
  calls `napi_open_handle_scope` from the wasm side (0 calls / 18
  wasm-routed tests, max depth 0).  All 4,913 suite-wide scope opens
  happen INSIDE emnapi via `Context.openScope` (callbacks +
  finalizers), never crossing the import boundary.  Per-call
  forwarding of all `Context.openScope` is feasible (~17 ms/test)
  but doesn't scale (estimated ~9.3 s for a 10k-request server).

  Right pattern: **root-scope rotation at quiescence points** — flush
  at `unofficial_napi_release_env`, between RPC requests at known
  quiescence, or periodic compaction when handle count exceeds a
  threshold.  Cheaper than per-call forwarding; achieves the same
  bounded-accumulation property.

  Status: deferred.  Today's accumulation is bounded by request
  count; no memory pressure observed in tests.  Promote when a
  long-running deployment shows growth.
  See experiments/r9-host-emnapi-init/FINDINGS.md and
  experiments/e7-scope-discipline-observation/FINDINGS.md.
- ~~`cluster-b-finalizers-noop`~~ + ~~`cluster-c-finalizers-noop`~~
  **RESOLVED** (2026-05-24, Agent A) by host-side
  `FinalizationRegistry`-driven dispatch.  Both clusters now register
  the host-side JS object (deref'd from the napi_value returned by
  `napi_create_external` / `napi_wrap` / `napi_add_finalizer`) with a
  module-level `FinalizationRegistry`.  When the JS object is GC'd by
  the host worker's V8, the FR callback fires the cached closure built
  by `makeHostSideCallbackClosure` (shape=FINALIZER), which round-trips
  to wasm via reverse-RPC where the wasm-side dispatcher resolves the
  funcref via `__indirect_function_table.get(cbPtr)` and invokes
  `void(*)(env, finalize_data, finalize_hint)`.  Observability counters
  (`finalizerStats.registered/fired/closureMissing/closureFailed`)
  exposed via `getFinalizerStats()` for diagnostic probes.

  Test gap: deterministic GC observation isn't possible without
  `--expose-gc` (browser-test-runner doesn't pass that flag).  Suite-
  side test asserts wiring (registration counter ticks); fire-on-GC
  validated via a dedicated probe script under `--expose-gc` (out-of-
  band).  F-9 sweep (32/33 ops) confirms the cluster handlers still
  function under the new dispatch path.
- ~~`cluster-d-define-class-properties`~~ — **RESOLVED** (2026-05-24,
  F-9 batch 4 cluster D follow-up) by decoding the
  napi_property_descriptor array (32B stride) in the
  `OP_NAPI_DEFINE_CLASS` handler, branching on
  method/getter/setter/value presence, wrapping each funcref via
  `makeHostSideCallbackClosure` (shape=NAPI_CALLBACK), and installing
  via `Object.defineProperty` on `Klass` (NAPI_STATIC bit set) or
  `Klass.prototype` (instance).  Verified by extending the F-9 sweep
  probe with a 2-descriptor class (instance method + static getter):
  22/23 ops PASS.
- ~~`cluster-d-cross-context-objects`~~ — **RESOLVED** (2026-05-24,
  F-9 batch 4 cluster D follow-up) by extending
  `cross-context-marshal.ts` with by-value tags (8-12, 17): plain
  object, dense array, typed array, ArrayBuffer, Date, and circular-ref
  back-pointer.  Object args now deep-clone across the host↔wasm
  boundary (postMessage / structuredClone semantics — identity is NOT
  preserved between separate marshal calls, but cycles within a single
  packValue call ARE preserved via per-frame `seen`/`byFrameId` maps).
  By-ref (tag 7) retained for callers that share an IdentityMap; falls
  through to by-ref for class instances (receiver throws cleanly if no
  shared map).  Verified via 7 marshal probes in the F-9 sweep:
  plain-obj, nested-obj, array-of-obj, date, uint8array, arraybuffer,
  circular-self-ref — all PASS.  Map/Set/RegExp remain unsupported
  (separate follow-up).

### Worker_threads (phase 1 shipped 2026-05-24)

- `worker-threads-phase-1-policy-opt-in` — `worker-threads-per-thread`
  policy is opt-in (not in `defaultBrowserPolicies`).  Currently only
  `new Worker(filename)` is supported through the policy patch.  Eval
  mode (`new Worker(code, { eval: true })`) and data-URL mode fall
  through to the original WorkerImpl (which throws on browser-target).
  Promote to default once phase 2 (postMessage) is proven.
- ~~`worker-threads-no-postmessage`~~ — **RESOLVED** by phase 2.
  `worker.postMessage(data)` and `parentPort.postMessage(data)` now
  shuttle structured-clone JS values between parent and child via the
  same wasm→host→main→host→wasm RPC chain that phase 1 used for spawn
  and exit.  cross-context-marshal.ts wire format handles primitives,
  plain objects, arrays, typed arrays, ArrayBuffers, Map/Set/RegExp,
  Date, and circular refs by value.  See
  `tests/js/worker-threads-message-roundtrip.js` for the end-to-end
  proof (parent → child → parent roundtrip with a nested object).
- `worker-threads-no-workerdata` — `options.workerData` is plumbed
  end-to-end as bytes through `__edgeSpawnNodeWorker` (phase 1 set up
  the payload, phase 2 wires marshal) but the child-side policy patch
  does NOT yet unmarshal the bytes into `require('worker_threads').
  workerData`.  Deferred to phase 2.x because the marshal call must
  happen inside lib's `Worker` constructor (which reads `options.
  workerData` at line 342) AFTER our EdgeWorkerImpl returns — needs a
  post-construction "first message" trick or wrapping the user-facing
  Worker class with a subclass that extracts options.workerData and
  marshals it via a side-channel.
- `worker-threads-no-terminate` — `worker.terminate()` is a no-op.
  Phase 3 wires a 'terminate' message that the child wasm honors.
- `worker-threads-no-error-event` — uncaught child exceptions exit the
  child with a non-zero code; the `exit` event fires with that code
  but `error` event does not.  Phase 3 wires structured error
  propagation via reverse RPC.
- `worker-threads-file-mode-needs-fs-visibility` — file-mode `new
  Worker('/abs/path.js')` requires the path to be visible to the
  child's wasm FS adapter (`/node-lib/**` works; `/tmp/*` does not
  cross-worker today — see `fs-write-not-visible-to-read` /
  `sab-fs-read-only-writes-not-persisted`).  No suite-side test uses
  file mode yet; the spawn-exit test bypasses the policy and uses
  `globalThis.__edgeSpawnNodeWorker` with an inline bootstrap script.
- `worker-threads-reverse-rpc-exit-fragility` — `process.exit(N)`
  called inside a reverse-RPC handler stack (e.g. directly inside the
  user's `worker.on('exit', cb)` callback) does NOT propagate cleanly
  to the parent's `_start` — the handler's try/catch swallows the
  ExitSignal.  User code must call `process.exit` from a natural
  libuv loop callback (setTimeout / setImmediate / nextTick).  The
  spawn-exit test polls a flag from a setTimeout for this reason.
  Phase 3 should clean this up by emitting the exit event via
  `process.nextTick` so user callbacks run on the natural stack.
- `worker-threads-child-sentinel-mangling` — main's child-wasm-worker
  message listener replaces "_start ran" with "_start.ran" in
  forwarded log text so the browser-test-runner's SENTINEL_RE doesn't
  match the child's exit-line and report the wrong code for the
  parent.  Hacky; cleaner alternatives: prefix the sentinel with a
  zero-width character, suppress the line entirely, or extend the
  runner to scope the match to the parent's "── edgejs.wasm" section.

### Cross-worker primitives

- `node-harness-regression` (2026-05-24, surfaced by E13/E14) —
  `browser-target/scripts/node-harness.mjs` invocations exit with
  code 127 in ~3ms after 15 host calls.  Trace: `wasi/thread-spawn`
  returns -1 then `wasix_32v1/proc_exit2(127)` during boot.
  Reproduces on `main` with a trivial `--eval "console.log('hello')"`.
  The `browser-test-runner.mjs` path (Playwright via Chromium) is
  UNAFFECTED — 31/0/3 baseline maintained.

  Both `browser-target/edgejs.wasm` (bundled May 23 at commit
  `44719a6b`) and the host-side TS layer have moved since.  E13/E14
  agents could not isolate which side regressed; the browser path
  works because it uses different wasi-shim semantics (JSPI suspend
  vs synchronous Atomics).

  Status: tracked.  Doesn't block the regression net we actually
  rely on (browser-test-runner).  Promote when the node-harness
  becomes the chosen verification path again (e.g. for CI in
  non-browser environments).

- ~~`zlib-have-should-not-go-down`~~ — **RESOLVED** (2026-05-24,
  E15) by `zlib-writestate-wasm` policy: `{post}`-patches
  `binding.{Zlib,Brotli*,Zstd*}.prototype.init` to swap the
  `Uint32Array(2)` argument for a wasm-backed twin allocated via
  `internalBinding('buffer').createUnsafeArrayBuffer(8)`.  Shipped
  in `defaultBrowserPolicies` + `minimalPolicies` — this is a
  correctness fix, not opt-in.  `compression-via-compressionstream`
  is now perf-only.  See `experiments/e15-zlib-fix/FINDINGS.md`.

  **Bug class documented in
  [docs/wasm-aliased-typedarray-pattern.md](./docs/wasm-aliased-typedarray-pattern.md)**
  — covers detection heuristic, current per-binding fix pattern, when
  to escalate to a generalized helper, and a sketch of that helper.
  E19 audit + E20 (`process-methods-wasm-state`) follow the same
  pattern.  Read the doc before adding a sixth fix or considering a
  napi-layer change.
- ~~`e18-slot-overflow`~~ — **RESOLVED** (E22 2026-05-24) by shared
  napi-memory data channel: new
  `OP_SUBTLE_DIGEST_VIA_NAPI_MEM = 0x0003` op carries
  `(algoName, dataOffset, dataLen)` in the RPC slot; bytes live in
  `napiHostMemory.buffer` at `DIGEST_STAGING_OFFSET = 128 KiB`.
  Inputs of arbitrary size (up to wasm memory cap, ~128 KiB initial,
  ~896 KiB growable) now hash correctly.  64KB test ships.  Small
  inputs continue to use the fast-path inline RPC slot.  See
  `experiments/e22-digest-slot-overflow/FINDINGS.md`.

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
  (Host-worker user-script path implements correct ordering — see
  `nexttick-before-microtask` test; in-process wasm path is the case
  this entry still applies to.)
- **`worker_threads.MessageChannel` would deadlock** — microtask-
  coordinated wakeups across workers need a single coordinated queue.
- **`lazy-load-from-microtask`** — see debt entry above. Regression
  test at `tests/js/regression-lazy-load-from-microtask.js`.
- ~~`microtasks-starved-by-pending-timer`~~ — **RESOLVED** by Lever B
  F-6 for the host-V8 user-script path; still present in the in-process
  wasm path (which retains JSPI suspension on `poll_oneoff` waits).
- ~~`synthetic-callback-info-hook-not-wired`~~ — **RESOLVED** by R7
  cbinfo synthesis (experiments/r7-cbinfo-synthesis/FINDINGS.md).  The
  `NAPI_CALLBACK` case in `registerWasmCallbackInvoker` now openScopes
  on the wasm-side emnapi context, mutates `scope.callbackInfo`, and
  passes `scope.id` as cbinfo.  Cross-context handle marshaling (R8)
  is the remaining piece needed before `napi_create_function` /
  `napi_define_class` can ship as host-RPC ops.

---

## Active followups (priority order)

### 1. Microtask checkpoint pump — premise was wrong; reframe required

**Reframed 2026-05-24 by E8 spike**
(experiments/e8-microtask-pump-spike/FINDINGS.md).

The original framing of this followup was:
> Edge's `_start` runs as ONE long synchronous task on the worker
> thread.  It never returns to the worker's event loop, so no task
> boundary fires, so microtasks never drain.

This is **partly wrong**.  E8 empirically tested three primitives
under JSPI suspension on the wasm worker:

| Primitive | Fires during JSPI suspension? |
|---|---|
| `Promise.resolve().then(...)` (microtask) | **Yes** ✓ |
| `setTimeout(..., 1ms)` (macrotask) | **No** ✗ — deadlocks |
| `Atomics.waitAsync(..., 1ms).value` (engine timer) | **Yes** ✓ |

**Microtasks DO drain on the wasm worker.**  V8's microtask scope
is processed during the JSPI await; only the worker's macrotask
queue freezes (the host loop can't dispatch while wasm holds the
thread at the C++ layer).

Of the 4 tests this followup was supposed to fix:
- `regression-lazy-load-from-microtask` — **already passes on the
  wasm path** (verified 3/3 stable runs).  Moved off `host=1`.
- `regression-microtask-not-starved` — **already passes on the
  wasm path** (verified 3/3 stable runs).  Moved off `host=1`.
- `finalization-registry-runs` — still fails, but for a different
  reason: `process.exit(0)` inside a `FinalizationRegistry`
  callback doesn't terminate before a surviving `setTimeout(200)`
  fires.  Reclassify: `process.exit` semantics issue.
- `unhandled-rejection-fires` — still fails, different reason:
  handler IS captured and IS fired, just AFTER a surviving
  `setTimeout(100)`.  Reclassify: lib's
  `process.nextTick(emit)` timing on the wasm path.

The 5 `host=1` microtask-ordering tests (await-resumes-as-microtask,
microtask-before-timer, nexttick-before-microtask,
promise-chain-drains-fully, queuemicrotask-orders-with-promise)
have mixed results on the wasm path — 2/5 pass, 3/5 fail or flake
on specific ordering semantics.  Keep `host=1` for those.

**Real remaining issues:**

1. ~~`process.exit` from a `FinalizationRegistry` callback~~ —
   **RESOLVED** by E9 (sleepSab wake from
   `unofficial_napi_terminate_execution`).
2. ~~`unhandledRejection` event timing~~ — **RESOLVED** by E10
   (host event-handler drains `process._tickCallback`).
3. ~~The 3 flaky `host=1` ordering tests~~ — **RESOLVED** (E23-redo
   follow-up, 2026-05-24).  Shipped fix paths (i) + (ii) combined:
   added new `unofficial_napi_yield_for_microtasks` import declared
   in `napi/include/unofficial_napi.h`; called from a wasm-only
   stack site at the top of `RunEventLoopUntilQuiescent`'s loop
   body BEFORE `uv_run` (drains microtasks BEFORE the next timer
   fires); JS-side handler wrapped via `WebAssembly.Suspending` so
   V8 drains microtasks at the JSPI suspend boundary.  The handler
   does 16 `await Promise.resolve()` iterations to drain deep
   promise chains.

   Suite: 36/0/3 maintained.  **All 5 microtask-ordering tests
   (microtask-before-timer, nexttick-before-microtask,
   promise-chain-drains-fully, await-resumes-as-microtask,
   queuemicrotask-orders-with-promise) now pass on the wasm path
   without `host=1`.**  Verified 3/3 stable runs each.

**Strategic implication:** the "microtask drain bug" was a stronger
argument for moving user JS to the host worker (Lever B) than the
reality supports.  The wasm path is more capable than the previous
docs claimed.  Re-evaluate the Lever B motivation against actual
costs.

**Historical approaches (now superseded by E8 findings):**

The earlier framing proposed four candidate fixes: (a) move wasm to
its own Worker via emnapi multithreaded mode, (b) syscall-level
Asyncify at the wasi-shim boundary, (c) full Asyncify on `_start`,
(d) C++-side context-aware drain in emnapi.  These were sized to
fix a problem (microtasks never drain) that E8 showed doesn't fully
exist.  Reads of those approaches are preserved in
[ARCHIVE.md](./ARCHIVE.md) for context but no longer block
deployment.

E8 attempted approach (b) and found `setTimeout` deadlocks under
JSPI on the worker — V8 holds the thread; macrotasks can't fire.
Approach (b) cannot be implemented without real wasm-stack-
switching (approach c).  Approach (a) is still a real option for
ESM / worker_threads support but no longer justified by microtask
drain alone.

**Status: downgraded.**  Not blocking any test in the corpus today
(2 regression tests moved to wasm path; remaining `.skip` tests
have different root causes now reclassified above).

### 2. Offload policies (Phase C in the architecture plan)

**Previously "Blocked-by-#1"** — E8 (2026-05-24) found microtasks
DO drain on the wasm path, so the supposed blocker is weaker than
documented.  Async host-offload policies should be re-attempted
with the corrected understanding; per-policy validation needed
(some may still have edge cases around `process.nextTick` timing
that E8 also uncovered).

`compression-via-compressionstream` is shipped as a spec / reference
(in `src/policies/`, registered as opt-in) but did NOT execute its
callback when last tested.  Worth retrying now that the microtask-
drain premise has been corrected.

Synchronous offloads (crypto random was the first) are NOT blocked
and remain a fine direction.

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
