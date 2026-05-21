# Edge.js Browser Target — NOTES

Running log of the browser port: what works, what's known-broken, and
what's deliberately deferred.  See [ARCHIVE.md](./ARCHIVE.md) for the
full historical trail of how each piece got built and the bugs hit
along the way (~2000 lines, newest-first).

This file: scannable in 90 seconds.  Newest entries at top.

---

## Project orientation

**Goal**: run unmodified edge.js (a Node-compatible runtime) inside a
browser via WebAssembly.  StackBlitz-grade Node compat in the browser.

**Architecture**: `edgejs.wasm` (built with `EDGE_NAPI_PROVIDER=imports`)
expects the host to provide three things:

- **WASI syscalls** — `browser-target/src/wasi-shim.ts`
- **Standard N-API** — `@emnapi/core` + our overrides
- **napi/v8 adapter (unofficial_napi_*)** — `browser-target/src/napi-host/`

Plus a SharedArrayBuffer-backed `WebAssembly.Memory`, a Service Worker
for HTTP bridging, and a FileSystem facade.

**Iteration loop**:
- **Node harness** (`browser-target/scripts/node-harness.mjs`): ~3s,
  same code paths as the browser, just `fs.readFileSync` instead of
  sync XHR.  Required for fast crypto/napi work.
- **Browser** (`vite dev` on `:5180`): ~15s, full end-to-end including
  Service Worker bridge.

---

## Current capability

| Surface | Status | Notes |
|---|---|---|
| Boot, console.log to stdout | ✅ | `_start` runs ~130-200ms |
| `process.exit(N)` | ✅ | clean teardown |
| `setTimeout` / `setInterval` | ✅ | via `poll_oneoff` Atomics.wait |
| `http.createServer` + fetch roundtrip | ✅ | Service Worker bridge, page relay |
| `fs.readFileSync` on `/node-lib/**` + `/node/deps/**` | ✅ | bundled adapter via sync XHR |
| `fs.writeFileSync` to userland paths | ✅ | in-memory only (no persistence yet) |
| `crypto.createHash().update().digest('hex')` | ✅ | sha256 verified correct |
| `crypto.randomBytes(N).toString('hex')` | ✅ | real entropy via `/dev/urandom` |
| `crypto.randomUUID()` | ✅ | real UUID v4 |
| `require('node:builtin')` (most) | ✅ | from compiled-in catalog |
| `import` (ESM) | ❌ | `module_wrap_*` are stubs |
| `https.createServer` / TLS | ❌ | not started |
| OPFS persistence (real disk) | ❌ | in-memory only |
| `worker_threads` | ❌ | not started |
| `child_process` | ❌ | needs subprocess model |
| Concurrent HTTP | ⚠️  | single-flight per-SW |

**Boot cost**: ~130-200ms `_start` time + ~50ms wasm compile (after first run cached).

**Auto-prepend**: every user `-e` script gets `try{Buffer.poolSize=0}catch{};`
prepended (worker.ts and node-harness.mjs).  Required for crypto correctness
— edge's Buffer pool slicing doesn't compose with our wasm-backed
ArrayBuffer model.  Invisible to users.  See ARCHIVE.md "Crypto FULL surface
working" for details.

---

## Active tech-debt catalog

Inline `#!~debt` markers point here.  Each is a deliberate shortcut with a
specific remediation path.  Counts as of writing: **52 markers** across the
browser-target tree.

### Boot-blocking / correctness

- `crude-circuit-breaker` — `CALL_LIMIT = 20000` in worker.ts.  Real fix:
  watchdog timer on progress, not call count.
- `fake-fs-fallback` — `path_filestat_get` returns success for paths the
  FS doesn't recognize (kept to avoid breaking libc cwd probes).
- `dynCall-before-table-ready` — `unofficial_napi_create_env` passes
  throw-placeholders for makeDynCall callbacks.  Trips on finalizers at
  process exit, harmless during run.

### Sockets / HTTP

- `single-listener` — one TCP listener at a time
- `single-flight` — one inflight HTTP request per Service Worker
- `no-keep-alive` — `Connection: close` forced in request synthesizer
- `no-chunked-encoding` — auto-flush requires `Content-Length`
- `no-outbound` — `sock_connect` returns ENOSYS (no http client → external)
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

- `namespace-default-fallbacks` — `imports-generated.ts` falls through to
  per-namespace defaults (napi=0, wasi=52).  "Implemented" means "callable
  with right arity," not "semantically correct."
- `override-bootstrap-only` — the napi-layer module-source override hook
  in `unofficial_napi_contextify_compile_function` catches only the ~11
  bootstrap files edge actually compiles through that entry, not
  lazy-loaded builtins like `inspector` / `url` / `crypto`.  See
  followup section above.
- `unverified-one-time-anomaly` in `mem-snapshot.ts` — diagnostic artifact
- Multiple `#!~debt` in `unofficial.ts` — most no-op stubs writing sensible
  defaults to out-params, ported from `napi/v8/src/*.cc`.  Promote when a
  workload lights them up.

---

## Active followups (in priority order)

### Universal module overrides via napi binding hook — PARTIAL (2026-05-21)

**Wiring is in place** but **only catches bootstrap-time modules**.

Hook lives in `unofficial_napi_contextify_compile_function`
(`browser-target/src/napi-host/unofficial.ts`).  Threading:
`NapiHostOptions.builtinOverrides` → `UnofficialHostContext.builtinOverrides`
→ filename-keyed substitution before `new Function(code, ...)`.  Node
harness exposes it via `--override <id>:<value>` (value can be a path,
literal source, or the string `null` for an empty stub).

**Verified working** — `--override internal/bootstrap/web/exposed-window-or-worker:null`
prints `[override] matched ...` and the wasm proceeds with the stub
source.

**Does NOT catch lazy-loaded builtins** like `inspector`, `url`, `crypto`.
Empirically (see NOTES debug 2026-05-21) only ~11 modules pass through
`unofficial_napi_contextify_compile_function` during a full `_start`
run: the per_context/* files, bootstrap/realm, bootstrap/node, the
web/exposed-* shims, the switches/* files, `main/eval_string`, and the
`[eval]-wrapper` for the user script.  Despite `realm.js:395` calling
`compileFunction(id)` → `BuiltinsCompileFunctionCallback` →
`unofficial_napi_contextify_compile_function`, no compile is recorded
for `inspector` when user code does `require('inspector')`, even
though the trace shows `eval (node:inspector:26:9)` proving its
source ran.  Source file sizes on disk match wasm catalog sizes
exactly, so the wasm isn't running a different version.  Some other
code path is loading these — candidates: `napi_run_script`
(unimplemented in our host but called from `EvaluateJsModule` in
`src/edge_module_loader.cc:4495`), a pre-snapshot, or a fast-path
that skips through emnapi.

#!~debt override-bootstrap-only: the hook works only for the modules
edge compiles via `unofficial_napi_contextify_compile_function`, not
all builtins.  Remediation: identify the second compile path (likely
`napi_run_script` since that's currently a stub) and add an
intercept there too.

### ESM support (`module_wrap_*`)

The 18 `module_wrap_*` impls are stubs that return placeholder handles.
Real Node code using `import` syntax fails at link/evaluate.  Probably
need Asyncify to bridge browser's async `import()` to sync wasm.
600-1500 LOC chunk.

### HTTPS / TLS

`https.createServer`, `tls.connect`, certificate parsing.  Edge bundles
OpenSSL — we just need to ensure the network paths work.  Some napi
plumbing likely needed.

### Real OPFS persistence

User wants this last.  Replace the in-memory writable layer with
`FileSystemSyncAccessHandle` backed storage.  Needs an async pre-warm
phase for directory handles.

### Test harness over `tests/js/*`

Edge ships small test inputs in `tests/js/`.  ~150 LOC Node runner that
iterates them, captures stdout, compares to expected.  Regression net
for everything we've built.

### worker_threads

Each worker = real Web Worker with shared memory.  Bridge `postMessage`
to our SAB transport.

### Memory hygiene

Buffers we `_malloc` are never `_free`'d.  Long-running apps OOM.  Need
FinalizationRegistry or explicit lifetime tracking.

### `Buffer.poolSize=0` for file scripts

Auto-prepend works for `-e` only.  Needs a deeper hook for `edge file.js`.

---

## Tools / inventory

- `browser-target/` — the host shim, Vite dev server, harness
- `browser-target/src/wasi-shim.ts` — WASI + WASIX syscalls (1400+ LOC)
- `browser-target/src/napi-host/` — emnapi composition + 80 unofficial_napi_*
- `browser-target/src/host/fs/` — FileSystem facade + 3 adapters (bundled, opfs, overrides)
- `browser-target/scripts/node-harness.mjs` — Node-side test loop
- `browser-target/public/edgejs.wasm` — symlink to the 26.5MB build artifact (gitignored)
- `patches/napi/*.patch` — local mods to napi/ submodule
- `scripts/setup-napi-patches.sh` — applies the patches on fresh checkout
- `ARCHIVE.md` — full historical NOTES (newest-first, ~2000 lines)
