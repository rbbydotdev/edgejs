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

### Newly opened

- `cjs-dynamic-import-no-host-callback` (opened 2026-05-30).
  `unofficial_napi_contextify_compile_function` in
  `browser-target/src/napi-host/unofficial.ts:722` uses a plain
  `new Function(...)` instead of a real `vm.compileFunction` impl.
  Plain `new Function` drops the `importModuleDynamically` parameter
  that lib's cjs/loader.js wires (`loader.js:1696`), so when CJS code
  does `import('node:process')` the dispatch falls through to the
  browser-V8 default `import()` and fails with "Failed to fetch
  dynamically imported module: node:process".  Manifest test:
  test/parallel/test-process-default.js.  Fix requires migrating the
  compile_function shim from `new Function` to a real
  vm.compileFunction-equivalent that captures the
  hostDefinedOptionId+importModuleDynamically and routes them through
  `__edgeDynImportImpl` like ESM modules do.  Architectural — out of
  scope for a preset patch.

- `corpus-mustcall-not-verified` (opened 2026-05-30).  Tests using
  `common.mustCall(fn, N)` on ASYNC events (stream `'end'` / `'close'`,
  timers, async_hooks, ...) are not honestly verified by the corpus
  runner.  Real Node lets the event loop drain naturally — once no more
  handles are pending, `'beforeExit'` fires, then `'exit'`, at which
  point mustCall's at-exit verifier runs against accurate counts.  Our
  libuv-wasix loop does NOT self-drain: after the user script's
  synchronous portion completes, deferring process.exit via
  setTimeout(0), setImmediate, or `process.on('beforeExit')` all fail
  to fire the queued exit — wasm hangs.  We therefore call process.exit
  synchronously from the driver, terminating the loop BEFORE async
  events fire, which means mustCall's verifier sees actual=0 for any
  event-driven handler.  Scaled-corpus measurement shows **87 of 178
  failures are mustCall mismatches** that would convert to passes (or
  honest failures) under a draining loop.  Fix requires making
  libuv-wasix honor natural drain (deep architectural work) OR a
  fundamentally different runner topology where each test runs in its
  own wasm instance with a timeout-based exit watchdog.  Until then,
  treat any pass rate higher than the synchronous-only baseline as
  potentially inflated.

- `edge-env-migration-thin-shim` (opened 2026-05-30).  Two presets
  (`worker-threads-per-thread`, `child-process-via-executor`) are
  partially migrated to the new edge-env framework — they live at the
  new path but their runtime sources still import from the legacy
  `src/policies/child-process-via-executor/` folder.  Should be moved
  fully when those files are next touched substantively — extract the
  template literals into sibling `.runtime.js` files (same pattern as
  `v8-serdes`) and update the imports.

- ~~`esm-rewrite-source-maps`~~ — **RESOLVED 2026-05-30 (same
  day).**  The blob trampoline now emits a Source Map v3 alongside
  the `// # sourceURL=` pragma — accumulated by
  `buildSourceMapComment` in `napi-host/esm-registry.ts`.  Each
  output line maps to its corresponding original line in the
  user's ESM source; the preamble lines are unmapped.  Encoded as
  a `data:application/json;base64,...` sourceMappingURL comment
  appended to both the blob and SW paths.  DevTools now shows
  accurate stack-trace line numbers and a clickable original-
  source view.  Column-level fidelity within a line is still
  approximate (specifier rewrites shift columns by tens of chars);
  promote to per-rewrite column tracking if/when column-accurate
  source maps become necessary.

- ~~`esm-import-meta-resolve-exports`~~ — **RESOLVED 2026-05-30
  (same day).**  `__edgeImportMetaFactory` in
  `napi-host/unofficial.ts` now passes a synthetic wrap
  `{url, isMain: false}` to lib's `initializeImportMetaCallback`.
  Lib's default callback delegates to
  `cascadedLoader.importMetaInitialize`, which sets `meta.resolve`
  to a closure backed by lib's real resolver — handles
  package.json conditional exports, node_modules walk, and the
  `imports` field.  Lib's resolver overrides our static-map
  fallback when wired.  The fallback (no lib callback registered,
  or it throws) still handles statically-known specifiers,
  absolute URLs, and relative URLs against the module's URL.

- ~~`esm-dynamic-import-phase`~~ — **RESOLVED 2026-05-30 (same
  day).**  `rewriteDynamicImport` now emits phase-aware helpers
  (`__edgeDynImport` / `__edgeDynImportSource` /
  `__edgeDynImportDefer`) selected from `imp.t` (ImportType enum
  from es-module-lexer).  `synthesizePreamble` defines all three;
  `__edgeDynImportImpl` accepts a `phase` parameter and dispatches
  to lib's `importModuleDynamicallyCallback` with the right phase
  constant (`kSourcePhase=1` or `kEvaluationPhase=2`).  Source-phase
  imports now route through lib's actual source-phase resolver
  (yielding the compiled WebAssembly.Module instead of the
  evaluated namespace).  Defer-phase intentionally throws with a
  clear message — lib doesn't ship a defer constant yet (ES2025
  defer is Stage 2); will wire once lib does.

- **`esm-evaluate-sync-jspi-blocked`** (2026-05-29, PARTIALLY
  RESOLVED 2026-05-30 via `esm-require-preeval` policy) —
  `require(esm)` synchronously can't suspend JSPI because lib's
  `ModuleJobSync.runSync → wrap.evaluateSync` arrives at our napi
  handler with multiple host-JS frames between JSPI's promising
  (`_start` wrap) and our Suspending import — the architecture
  runs user code via `contextify_run_script`'s host-V8 `new
  Function(source)()`, and lib's CJS/ESM loaders are loaded the
  same way (host V8 via `napi_run_script`).  V8 throws "trying to
  suspend JS frames" because no wasm-only call path exists for
  this entry.
  **Partial resolution (b₁)**: `esm-require-preeval` policy (default
  on) populates a `globalThis.__edgePreEvalEsmCache` (Map<file-URL,
  namespace>) before user CJS runs.  The cache is filled two ways:
  (1) `globalThis.edgejs.preloadEsm([...specifiers])` — explicit
  user-facing API for the long tail; (2) auto-scan of the entry
  CJS source for literal `require(...)` patterns + transitive CJS
  walk via `fs.readFileSync` (patched into
  `internal/process/execution.js:evalScript`).  As of 2026-05-30
  the scanner uses Node-spec resolution
  (`createRequire(parent).resolve(spec)`, free node_modules walk +
  exports field) and Node-spec classification (extension +
  `LOOKUP_PACKAGE_SCOPE` walk to honor `"type":"module"` on `.js`
  files, stopping at the `node_modules` boundary).  Our
  `unofficial_napi_module_wrap_evaluate_sync` handler checks the
  cache before throwing.
  **Coverage in practice**: any `require(literal-string)` whose
  resolution would have worked at runtime is now reachable by the
  scanner — including bare specifiers (`require('chalk')`),
  scoped (`require('@org/pkg')`), subpath (`require('lodash/get')`),
  and `.js` files in `"type":"module"` packages.  Cases that still
  miss: computed/dynamic specifiers (`require(name)`,
  `` require(`./${x}`) ``), runtime-discovered files (`fs.readdir +
  require`), eval/new-Function-constructed requires, monkey-patched
  require chains, and conditional branches the scanner explores
  fully but whose targets weren't predictable at scan time.  The
  miss rate depends entirely on how dynamic the codebase is — pure
  static-require code is essentially 100% covered; plugin-heavy
  frameworks with runtime composition hit the long tail more often.
  Misses still throw `ERR_REQUIRE_ASYNC_MODULE` with a remediation
  message pointing at `edgejs.preloadEsm`.
  **Plus b₄ Sucrase backstop** (opt-in): bumps coverage further by
  catching cache-miss cases at runtime — transforms the `.mjs`
  source via Sucrase's `imports` transform and evals as CJS in a
  constructed context.  Fake-ESM semantics (plain object instead of
  Module Namespace Object); TLA modules still throw (detected via
  compile-time SyntaxError, no false positives).  Suitable when
  approximate ESM semantics are acceptable for the dynamic-require
  long tail.
  Marker sites:
  `napi-host/unofficial.ts:unofficial_napi_module_wrap_evaluate_sync`,
  `policies/esm-require-preeval.ts`,
  `policies/esm-require-sucrase-backstop.ts`.  Tests:
  `tests/js/esm-require-preeval-explicit.js`,
  `tests/js/esm-require-preeval-api.js`,
  `tests/js/esm-require-sucrase-backstop.js`,
  `tests/js/esm-require-sucrase-tla-still-throws.js`.
  **Full resolution** would require either (a) moving user JS into
  wasm-V8 (undoes F-6, regresses microtask tests), or (b₂) wasm-V8
  ModuleWrap C++ binding port (~500-1500 LOC C++, partial
  isolate split for module bodies). See
  `joyeecheung.github.io/blog/2025/12/30/require-esm-in-node-js-from-experiment-to-stability/`
  for Node's upstream implementation using V8's
  `v8::Module::Evaluate` (sync-resolved for non-TLA graphs).
  StackBlitz inherits this for free because they run a single
  browser-V8 isolate (no wasm-embedded V8) — see session research
  on their architecture.  Not currently planned for edge.

- ~~`esm-cyclic-live-bindings`~~ — **RESOLVED 2026-05-29.** Path (a)
  shipped: `synthesizeUrl` in `napi-host/esm-registry.ts` detects
  cycles via a DFS-color graph walk and routes through the service
  worker instead of blob URLs.  Each record in the cyclic subgraph
  gets a stable `/_edge_esm/<id>` path; sources are generated using
  the pre-assigned URLs (no chicken-and-egg) and posted to the SW via
  the worker → page → SW bridge in `worker.ts` + `main.ts`.  SW caches
  source by path and serves on fetch — V8 sees real cross-referencing
  module URLs and its bytecode-level cycle handling kicks in.  Test:
  `tests/js/esm-cycle-live-binding.js` (valid ESM cycle: defers
  cyclic access through a function to avoid TDZ on eager evaluation
  of the entry module — same constraint real Node enforces).  The
  blob path is still default for cycle-free graphs (faster: no SW
  round-trip).

- ~~`esm-per-module-dynamic-import`~~ — **RESOLVED 2026-05-29.** The
  `esm-via-blob-import` policy now mirrors each module's per-module
  dynamic-import registry into a Map keyed by `referrer.url`, then
  wraps `initializeESM` to override the global dispatcher with one
  that prefers our per-URL entry before falling through to lib's
  symbol-based default. Host's `__edgeDynImportImpl` calls the global
  callback with the proper 5-arg signature (`(refSym=null, spec,
  phase=2, attrs={}, refName=parentUrl)`); the wrapped per-module
  callback's return value (`m.namespace`) becomes the dynamic-import
  resolution. Verified by `tests/js/esm-dynamic-import.js`.

- **`child-process-ipc-sendhandle`** (2026-05-27, P3.3; PARTIALLY
  RESOLVED 2026-05-28 — MessagePort now works via NativePortBridge) —
  `cp.send(msg, handle)` in advanced mode wraps the handle in an
  `{__edgeSendHandle, msg, handle}` envelope and transfers via the
  existing structured port; receiver unwraps and emits `'message'`
  with (msg, handle). Supported handles:
    * **`ArrayBuffer`** — direct native transfer.
      `child-process-sendhandle-transferable`.
    * **`MessagePort`** (edge.js Node-style) — bridged via
      `NativePortBridge`: the send override creates a native
      `MessageChannel` (the ctor is cached at `worker.ts` module load
      as `globalThis.__edgeNativeMessageChannel` before edge.js mutates
      globalThis), proxies messages bidirectionally between the user's
      edge.js port and the local native half, and transfers the native
      remote half across the wire. Receiver gets a real native
      MessagePort.
      `child-process-sendhandle-messageport`.
  Still unsupported:
    * `net.Server` / `net.Socket` — need OS fd-passing (SCM_RIGHTS on
      Unix, DuplicateHandle on Windows); not possible without a kernel.
      `cluster.js` socket-sharing remains blocked here, not on
      MessagePort. (Note: these are the ONLY handle types Node itself
      supports for `cp.send` — ReadableStream/WritableStream were
      mentioned in earlier session notes as speculative followups but
      Node doesn't accept them either, so a bridge would add API
      surface that isn't Node-portable.)
  Warn-once at `internal-post-patch.runtime.js` reflects the supported
  list + the why-not.

- **`child-process-kill-cooperation`** (2026-05-27, P3.8) — `child.kill(sig)`
  fires the executor's `opts.signal` (AbortSignal) and returns 0
  unconditionally. The executor MUST poll `opts.signal` to honor the
  kill; non-cooperating executors run to completion. Real Node delivers
  an OS signal that interrupts the syscall the child is in — impossible
  without a real OS process. Documented; test
  `child-process-kill-cooperative` demonstrates the cooperator case.
  No test for non-cooperator (would need a deliberately-broken executor).
  Marker site: `policies/child-process-via-executor.ts:100`.

- **`child-process-ipc-advanced-serialization-types`** (2026-05-27, P3.7;
  RESOLVED 2026-05-28) — the `serdes` binding's Serializer/Deserializer
  now emits/reads **V8's actual wire format** (kVersion=15), making
  bytes byte-for-byte compatible with Node.js `v8.serialize()` and
  `v8.deserialize()`. Implementation lives in
  `policies/child-process-via-executor/serdes-shim.runtime.js`; the
  SerializationTag enum + varint/zigzag/double helpers are ported
  directly from `deps/v8/src/objects/value-serializer.cc` (the file
  is referenced inline as the canonical spec). Round-trips Map, Set,
  Date, BigInt, RegExp, ArrayBuffer, all TypedArrays + DataView,
  primitives, plain object/array, and refs/cycles. Verified by
  `v8-serdes-wire-format` (21 byte-exact assertions vs Node) and
  `v8-serdes-types` (type-fidelity round-trip). Coverage gaps tracked
  inline at the top of the file: SharedArrayBuffer transfer, Wasm
  module/memory transfer, Error subtype subtags, JSPrimitiveWrapper
  serialization, host-object hook protocol — these are the long-tail
  ~20% real build-tool caches almost never touch.

- **`host-rpc-sync-reverse-drain`** (2026-05-27, P3.6; RESOLVED
  2026-05-28) — `SyncRpcClient` takes a `drainReverseRequests`
  callback that `RpcServer.drainOnce()` plugs into. While the wasm
  worker is parked in `Atomics.wait` for a forward reply, the wait
  loop drains EAGERLY (no pressure gate) and dispatches handlers.
  Verified by `child-process-ipc-burst-limit` (1000 cp.sends, all
  received). Eager draining is safe because of the two consumer-side
  fixes below.

- **`ring-publish-order-vs-slot-index`** (2026-05-27, P5; RESOLVED
  2026-05-28) — `drainRing` returns READY slots in slot-INDEX order,
  not publish order: `tryClaimSlot` always scans from slot 0, so eager
  draining can free a low-index slot fast enough that a later chunk
  re-uses it, and the next `drainRing` returns it before older still-
  pending slots. Used to corrupt `child-process-spawn-streaming-large`
  at chunk boundaries. **Fix**: `sortByRequestId` in `rpc-server.ts`
  sorts each drained batch by the monotonic per-client `requestId`
  (already in the request header at offset 4) before dispatching. No
  SAB-protocol change needed. Wraparound-safe via signed difference.

- **`advanced-ipc-channel-null-race`** (2026-05-28, RESOLVED in same
  commit) — In advanced-mode IPC, the IPC pipe (stdio[3]) is bypassed
  entirely — messages go via the wasm<->host structured port — but
  EdgeProcess._handleEvent EXIT used to _endRead it anyway, which
  triggered lib's setupChannel onread to see UV_EOF and null
  `target.channel`. The advanced-mode `register` handler's
  `if (self.channel)` guard then dropped the in-flight 'message'
  nextTick for the final IPC reply (typically the bye-echo).
  **Fix**: EdgeProcess tracks `_isAdvancedIpc` (set from
  `options.serialization === 'advanced'` in `spawn()`). EXIT/ERROR
  branches in `_handleEvent` skip `_endRead` on the IPC pipe when
  `_isAdvancedIpc` is set. lib's onexit still fires 'exit' normally;
  if the user wants disconnect semantics they call `child.disconnect()`
  explicitly (our override handles it). Verified by
  `child-process-hard-kill-ipc-advanced` (10/10 in isolation).

- **`async-spawn-chunk-size-from-ring`** (2026-05-27, P0.1) — RESOLVED in
  the same commit it was opened: `ASYNC_CHUNK_SIZE` was hard-coded to
  16 KB while ring slots are 4 KB, so any single stdout/stderr write
  over ~4 KB silently dropped (RangeError from `payload.set` swallowed
  by fire-and-forget `void reverseClient.call(...).catch`). Now derived
  from `RING_CONFIG.slotSize` minus framing. Regression covered by
  `child-process-spawn-streaming-large`. Marker site: `host-worker.ts`
  (no longer marked; moved to derived constant).

- **`async-spawn-pipe-keepalive-imbalance`** (2026-05-27, P0 audit;
  RESOLVED 2026-05-27 P1.5) — `EdgePipe` now uses an opt-in
  `_heldKeepalive` flag so ref/unref/close only adjust the keepalive
  counter when the pipe actually holds an acquire. Construction no
  longer auto-pins; the per-child Process keepalive is the baseline.
  See `bindings-shim.runtime.js:142-156` (ref/unref) and 268-283
  (close). Verified by `child-process-ref-unref`.

- **`slot-deleters-stubbed-for-wasi-cli`** (2026-05-26; not planned to
  fix — see scope below) — Running the real per-slot deleters in
  `Environment::slots_` during wasmer-WASI `proc_exit` teardown trips
  a wasmer-side problem. Originally (2026-05-26) observed as an OOB
  crash; 2026-05-29 bisect attempt via `fprintf` instrumentation in
  `RunSlotDeleters` made wasmer hang at startup before any output —
  same family as the LLVM-backend bug we already patched (see
  `patches/wasmer-compiler-llvm-7.1.0-call-indirect-phi-fix.patch`),
  just a different trigger pattern. Stubbed in
  `src/edge_environment.cc:RunSlotDeleters` (just `slots->clear()`).
  **Scope:** this code path only runs under `napi_wasmer`, which exists
  solely as a CI lane for the upstream Node test corpus. The shipping
  target (browser-target) tears down via Worker termination, never
  `proc_exit`, never reaches this function. The leak is bounded to
  the wasmer process lifetime; OS reclaims at exit. **Not planned to
  fix on the wasmer side.** If the CI lane ever needs the deleters
  to actually run, the right move is to retire `napi_wasmer` and run
  the Node corpus through browser-target itself (the same wasm blob,
  the JSPI host; no `proc_exit`, no wasmer LLVM codegen surface).

### Recently resolved

- **`process-exit-blocked-poll`** (2026-05-26, e41) —
  `process.exit()` from inside a libuv callback was not honored: V8's
  `TerminateExecution()` is a no-op at napi callback boundaries in
  this wasm V8 build, and `uv_stop` alone cannot wake an
  already-blocking `uv__io_poll`. The loop continued until the next
  pending timer fired, racing the safety-timer in tests.
  **Fix**: dedicated `uv_async_t exit_wake_async_` in
  `Environment`, signaled from `Environment::Exit` to wake `io_poll`
  so `stop_flag` is checked promptly at the next iteration top.
  Shipped alongside the wasi-shim line-1122 fix
  (`pollOneoffAsyncImpl` was taking the timer-only branch even when
  pipe-read subs were present). See
  `experiments/e41-process-exit-diagnostic/FINDINGS.md`.

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
- ~~`worker-threads-no-workerdata`~~ — **RESOLVED** (Phase 3a, e33+).
  Parent-side: wrapping Worker subclass grabs `options.workerData`
  before super() and stashes via `globalThis.__edgePendingWorkerData`
  (packed bytes), which EdgeWorkerImpl picks up and ships to the
  child via `__edgeSpawnNodeWorker`. Child-side: WORKER_THREADS_POST_PATCH
  unmarshals `globalThis.__edgeUserWorkerDataBytes` and exposes as
  `require('worker_threads').workerData`. Verified by
  `e33-phase3-integration` (workerData round-trip with nested obj +
  `e34-phase5-eval-mode`).
- ~~`worker-threads-no-terminate`~~ — **RESOLVED** (Phase 3b, e33+;
  spoof-proof envelope e34+). `worker.terminate()` flows lib →
  `kHandle.stopThread()` → control-channel TERMINATE message that the
  child wasm honors; terminate Promise resolves with code 1. Verified
  by `e33-phase3b-terminate`.
- ~~`worker-threads-no-error-event`~~ — **RESOLVED** (Phase 3, e33+).
  Child installs `process.on('uncaughtException', ...)` handler that
  packs the error via `packPostMessage` and sends back through
  reverse-RPC; parent receives, emits `'error'` then `'exit'` with
  non-zero code. Same wiring for unhandledRejection.
- `worker-threads-file-mode-needs-fs-visibility` — file-mode `new
  Worker('/abs/path.js')` requires the path to be visible to the
  child's wasm FS adapter (`/node-lib/**` works; `/tmp/*` does not
  cross-worker today — see `fs-write-not-visible-to-read` /
  `sab-fs-read-only-writes-not-persisted`).  No suite-side test uses
  file mode yet; the spawn-exit test bypasses the policy and uses
  `globalThis.__edgeSpawnNodeWorker` with an inline bootstrap script.
- ~~`worker-threads-reverse-rpc-exit-fragility`~~ — **RESOLVED**
  (2026-05-25, phase 2 follow-up) by wrapping every reverse-RPC
  dispatcher call (`OP_DELIVER_USER_WORKER_EXIT`,
  `OP_DELIVER_MESSAGE_TO_CHILD`, `OP_DELIVER_MESSAGE_FROM_CHILD`) in
  `setImmediate(...)` via the `dispatchOnLibuvTick` helper in
  `browser-target/src/worker.ts`.  The user's event-handler callback
  now runs on libuv's check-phase tick, outside the reverse-RPC
  handler's try/catch, so `process.exit` from inside a 'message' or
  'exit' handler propagates through `_start`'s normal exit-signal
  path.  The phase-1 spawn-exit test still uses a polling pattern
  because it bypasses the policy patch — kept as-is for historical
  consistency, but no longer required.
- `worker-threads-uses-js-keepalive-not-tsfn` — historical slug; kept
  stable for backrefs from
  `browser-target/src/policies/worker-threads-per-thread.ts` and
  `browser-target/src/napi-host/emnapi.ts`.  `parentPort` (child side)
  and `Worker` (parent side) need libuv to stay alive while there's a
  'message' listener registered, AND need loop iterations to actually
  drive `setImmediate`-queued reverse-RPC deliveries — without
  iteration, libuv parks in `poll_oneoff` and `setImmediate` never
  runs.

  **v2-cutover update (2026-05-25):** the original premise — "v2's
  `_emnapi_runtime_keepalive_push` would unblock real TSFN" — turned
  out to be wrong for our wasi-libc edge.js.  `_emnapi_runtime_keepalive
  _push` is an empty stub in non-Emscripten builds (`vendor/emnapi/
  packages/core/dist/emnapi-core.js:605-606`) because the real impl is
  loaded from Emscripten's virtual `emscripten:runtime` module which
  edge.js doesn't bring.  And `emnapiCtx.refCounter` (the other
  candidate keepalive surface) is gated on `process.once +
  MessageChannel` not being available at `createContext()` time inside
  the wasm-runtime worker.  Net: TSFN dispatch runs on the browser
  worker event loop and has no path into edge's libuv.

  **Superseded — Real Path A landed (2026-05-25):** the right
  primitive is a host-managed `uv_async_t` handle exported by the
  edge.js guest, not TSFN.  `experiments/e23-real-path-a-discovery/
  FINDINGS.md` documents the discovery: edge.js's wasi-libc libuv
  exports `uv_async_init` / `uv_async_send` / `uv_ref` / `uv_unref` /
  `uv_close` / `uv_default_loop`, which is enough surface area to
  allocate a 64-byte handle in guest memory and drive it from the
  host JS side.  `browser-target/src/napi-host/uv-async.ts` wraps the
  exports as an `acquireSlot(cb)` factory; the policy in
  `policies/worker-threads-per-thread.ts` acquires one slot per
  Worker / parentPort and calls `.ref()` / `.send()` / `.close()`
  directly on it; `worker.ts`'s `pokeWorkerSlot` /
  `pokeParentPortSlot` call `.send()` from the reverse-RPC handlers.
  Result: every `setImmediate`-queued delivery wakes
  `poll_oneoff` immediately via `uv__async_io`, the keepalive shows
  up as a real `uv_async_t` pending handle, and the 50ms
  `setInterval` wakeup is gone.

  The hybrid TSFN-backed dispatch shipped briefly as commit
  `94bed439` ("hybrid Path A: ship TSFN-backed reverse-RPC dispatch")
  and was retired in the follow-up cleanup — `dispatchOnLibuvTick`
  is back to a plain `setImmediate(try/catch)` wrap; `uv_async_send`
  is what actually wakes the loop now.  See commit `be4cec4c`
  ("Real Path A: uvAsync keepalive replaces setInterval in worker-
  threads policy") for the cutover and the cleanup commit immediately
  after for the dead-code removal.

  Remaining observable wart: the keepalive shows up under
  `process._getActiveHandles()` as a `uv_async_t` pending handle,
  not as a `MessagePort` / `Worker` handle.  We don't synthesize the
  MessagePort/Worker shape on top of the slot — the slot IS the
  libuv-visible primitive.  Closing the gap would require a guest-
  side wrapper that registers as a `MessagePort`-typed handle in
  edge.js's internal handle table; tracked separately if/when it
  matters for a real consumer.

- `crypto-randombytes-v2-mirror-gap` (2026-05-25, v2 cutover regression;
  WORKED AROUND via `crypto-host-random` policy which routes
  `randomBytes`/`randomFill`/`randomUUID` through
  `globalThis.crypto.getRandomValues` -- avoids the broken wasm crypto
  path entirely. `crypto-randombytes` passes. The underlying emnapi v2
  ArrayBuffer-mirror divergence is still the root cause of any future
  wasm-crypto regression that hits the FastBuffer alloc path;
  root-cause fix (options a/b/c below) still deferred but no longer
  blocking any visible test.)
  — `crypto.randomBytes(N)` returns all-zero buffers on v2; suite
  shows 40/1/0/3 vs. v1's 41/0/0/3 baseline.  Diagnosed in a worktree
  probe (instrumentation removed): edge.js's wasm crypto path allocates
  a wasm-backed ArrayBuffer via our overridden `napi_create_arraybuffer`
  (e.g. handle 343, ptr 56297872, foundWab=true) — confirmed wasm-
  backed.  But the user-visible `new FastBuffer(16)` returns a SEPARATE
  napi handle (e.g. 336) whose underlying ArrayBuffer is plain JS,
  NOT shared with wasm memory (`sharesWasmAB=false`).  Each
  `napi_get_buffer_info(buf=336)` returns a different `dataPtr` /
  `len` — emnapi v2 appears to allocate a fresh per-call mirror.

  Root cause: in v1 emnapi, the auto-mirror between JS ArrayBuffer and
  wasm linear memory was bidirectional and per-call (`emnapiNs.syncMemory`
  fired on both directions); the wasm crypto's writes to the mirror
  ended up reflected in the JS-side Buffer.  In v2 the mirror
  semantics are different (the trace shows `syncWasmToJs` running but
  the JS Buffer still sees zeros — the call-side gets fresh
  allocations each time, not a stable mirror).

  Workaround paths: (a) extend the existing `patchEmnapiToUseWasmBacked
  Buffers` to also override `napi_create_buffer_copy` so the FastBuffer-
  ALLOC path comes back wasm-backed (handle 343-style);  (b) add a
  post-call sync hook on napi_get_buffer_info / get_arraybuffer_info
  to copy wasm→JS after the C++ caller writes;  (c) fix Node's
  FastBuffer construction in lib to allocate from `internalBinding('buffer')
  .createUnsafeArrayBuffer` (which IS wasm-backed) instead of `new
  Uint8Array(size)`.  All are 1-day-ish refactors; deferred.
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

- ~~`vendored-emnapi-flag`~~ — **INVERTED** (2026-05-25, v2 cutover).
  Vendored v2.0.0-alpha.1 is now the DEFAULT runtime; flag-OFF
  (`EDGE_USE_VENDORED_EMNAPI=false`) is broken because the codemod in
  `scripts/codemod-v1-to-v2.mjs` rewrote `src/napi-host/*` from v1's
  Context API (`handleStore.get(h)?.value`, `ensureHandle(v)`,
  `addToCurrentScope(v)`) to v2's public API
  (`jsValueFromNapiValue`, `napiValueFromJsValue`).  V1's npm
  @emnapi/* doesn't have those methods on Context, so flag-OFF
  fails uniformly.  The cutover landed via the env=bridge.address
  bridge in `unofficial_napi_create_env` (v2 invokes callbacks with
  `envObject.bridge.address` as napi_env, not `envObject.id` — the
  wasm-side state lookup needs the same identifier both ways).
  Suite on v2: 40 pass / 1 fail / 0 err / 3 skip; the failure is
  `crypto-randombytes` (returns all-zero buffers — likely a
  buffer-override / handle-binding interaction with v2's
  `napiValueFromJsValue` adding to currentScope rather than v1's
  `addToCurrentScope` returning a Handle).  See commit
  `b1b6f9b1` for the breakthrough fix.
- `vendored-emnapi-flag-original` (L0 2026-05-23, kept for history) —
  Old debt: `EDGE_USE_VENDORED_EMNAPI=true`
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

### 3. ESM support (`module_wrap_*`) — RESOLVED 2026-05-29

Phases 1, 2, 3, 4 shipped end-to-end + cyclic graphs handled via the
SW-served-URL fallback (see `esm-cyclic-live-bindings` archived entry
above).  Plus the close-the-gap batch: per-module
`importModuleDynamically` callback, C++ `host_defined_option_symbol`,
`import.meta.resolve`, JSON attribute imports, vm.SyntheticModule with
JSON inline / global lookup, live-binding namespace, Wasm-ESM imports,
source-phase imports (`get/set_module_source_object` storage), SW URL
cleanup on destroy.

The only known limitation is `require(esm)` (`#!~debt esm-evaluate-
sync-jspi-blocked`) — architectural, documented as not-supported with
clear remediation.

Tests: 12 ESM scenarios — single-module, named+default, re-export
chain, TLA, dynamic import (per-module callback), `import.meta.url`,
`import.meta.resolve`, JSON + vm.SyntheticModule, Wasm imports, source-
phase round-trip, live bindings, cyclic live-binding.  All green.

**Architecture** (no Asyncify): the napi `module_wrap_*` family —
`create_source_text`, `create_synthetic`, `link`, `instantiate`,
`evaluate`, `evaluate_sync`, `get_namespace`, `get_status`,
`get_module_requests`, `has_top_level_await`, `has_async_graph`,
`get_error`, `destroy`, `set_export`, callback setters — all live in
`browser-target/src/napi-host/unofficial.ts` backed by
`napi-host/esm-registry.ts`. The registry mints **blob: URLs** for
each module (one per ModuleWrap), rewrites dependency specifiers in
the source to point at the dependency's blob URL, then calls the
browser's native `import(blobUrl)`. The browser's V8 IS the same V8
Node uses — TLA, cyclic refs, live bindings, namespace objects all
work natively. `evaluate_sync` is wrapped with
`WebAssembly.Suspending` so its async blob import appears sync to the
wasm caller (precedent: `unofficial_napi_yield_for_microtasks`).

**Phase 1 — static ESM**:
`tests/js/esm-source-text-basic.js`,
`tests/js/esm-named-and-default.js`,
`tests/js/esm-re-export-chain.js`. All green.

**Phase 2 — top-level await**: free with the JSPI wrap;
`tests/js/esm-top-level-await.js`. Green.

**Phase 3 — dynamic `import()`**:
`napi-host/esm-registry.ts:rewriteDynamicImport` substitutes
`import(...)` with `__edgeDynImport(...)`; host installs
`globalThis.__edgeDynImportImpl` that calls lib's global
`importModuleDynamicallyCallback` (registered via
`setImportModuleDynamicallyCallback`) with the proper 5-arg
signature.  The `esm-via-blob-import` policy mirrors each module's
per-module `importModuleDynamically` registry into a Map keyed by
`referrer.url` and installs a wrapping dispatcher around lib's
global callback that prefers per-URL routing before falling through
to lib's symbol-based default.  This lets
`new vm.SourceTextModule(src, { importModuleDynamically: cb })`
fire `cb` even though the user source runs in browser-V8 via the
blob trampoline.  Falls through to native browser `import()` for
absolute URLs (blob:/data:/https:).  Test:
`tests/js/esm-dynamic-import.js`.

**Phase 4 — import.meta**:
`rewriteImportMeta` substitutes `import.meta` with `__edgeImportMeta`,
a closure local that host's `__edgeImportMetaFactory(url)` initializes
with the **lib-provided URL** (not the leaky blob: URL). If lib
registered an `initializeImportMetaObjectCallback` it runs to layer
additional properties. Test: `tests/js/esm-import-meta-url.js`.

**Policy**: `esm-via-blob-import` is in `defaultBrowserPolicies`.
Its remaining job is the per-URL dynamic-import registry + dispatcher
described under Phase 3 above.  Originally it also synthesized
`host_defined_option_symbol` on every wrap, but that's now done
natively in `src/internal_binding/binding_module_wrap.cc:ModuleWrapCtor`
via `unofficial_napi_create_private_symbol`.  The JS-side Symbol
synthesis is kept as a belt-and-suspenders fallback so the policy
works against wasm builds without the C++ fix.

**Cached native intrinsics**: `worker.ts` caches `NativeURL` and
`NativeBlob` at module load and exposes them on
`globalThis.__edgeNative{URL,Blob}` — edge.js mutates the global
`URL` during bootstrap (lib/internal/url.js) which would otherwise
yield `blob:nodedata:` URLs the browser can't import. Same pattern
as `__edgeNativeMessageChannel` and the TextEncoder fix (#14).

**Handle lifetime**: napi values don't survive past their originating
scope (emnapi recycles them). `unofficial.ts` allocates its own
stable u32 IDs for ESM records and stores the handle ↔ record map
internally; the C++ side passes the u32 around as `void*`.

`--experimental-vm-modules` is now passed unconditionally in
`worker.ts:1259` so `vm.SourceTextModule` is usable from user code.

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
