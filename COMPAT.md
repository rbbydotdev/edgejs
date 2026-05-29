# Node.js Built-in Module Compatibility

Living document tracking which Node.js built-in modules work across
edge.js's deployment surfaces, with a side-by-side reference against
other Node-compat runtimes. Goal: be honest about what works, what's
partial, what's stubbed, and what we don't intend to ship.

**Last updated**: 2026-05-30.

## edge.js's two surfaces

| Surface | What it is | How JS executes |
|---|---|---|
| **edgejs** (base) | The upstream Node-fork: `lib/`, `src/`, `deps/`, `napi/`. Builds to `edgejs.wasm` runnable in any WASI(X)-compliant host (wasmer-CLI lane today). Reuses Node's stdlib; the host is real-OS-shaped. | Real V8 inside wasm |
| **edgejs-web** (browser-target) | The browser distribution: `browser-target/`. Adds a JS-side host (napi-host, wasi-shim, policies) that runs the same wasm under a browser DedicatedWorker via JSPI. | User JS routes through host V8 via `napi_run_script` (F-6 lever) |

Both share the same lib/. Differences come from (a) what the host can
provide (real OS vs browser sandbox) and (b) which policies are active.
The columns below distinguish them because the same Node module can
work differently depending on which surface answers the syscalls.

## How to read this

| Symbol | Meaning |
|---|---|
| ✓ | Fully supported — passes most/all Node test corpus, no known major gaps |
| ◐ | Partial — works for common cases; some APIs or edge cases missing or approximated |
| ⊘ | Stubbed — module is importable but key APIs throw / no-op |
| ✗ | Not implemented — import throws or returns empty |
| — | Not applicable / architectural impossibility in this runtime |
| ? | Unknown — needs verification |

**edge.js status reflects current `main` branch.** Verify via `tests/js/`
(green = supported), `browser-target/src/policies/*` (compensating
policies), and `browser-target/src/napi-host/unofficial.ts` `#!~debt`
markers (known gaps).

## Side-by-side compat

**Column notes**:
- **edgejs** (base) — most cells reflect "inherits Node's lib + C++ binding"; pure-JS modules are ✓ by default. Network, FS, and process behavior depend on the WASI(X) host. Cells marked `?(host)` mean "depends on host capability; not exhaustively tested in our CI."
- **edgejs-web** — the browser-target distribution; cells reflect current `main` per `tests/js/`, policies, and `#!~debt` markers.
- **StackBlitz** — no per-module matrix is published; cells reflect (a) categorical limits from their troubleshooting page, (b) known bugs from public GitHub issues, (c) ✓ for modules where real Node works and no carve-out / bug is documented.

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| **Core** | | | | | | | | |
| `assert` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Pure JS; Bun: 100% Node-suite |
| `buffer` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | edgejs-web: `buffer-wasm-aliased` policy carries it |
| `console` | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | edgejs-web: routed to host-worker logs |
| `events` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Pure JS; Bun: 100% Node-suite |
| `process` | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ✓ | edgejs-web: `process-methods-wasm-state` policy; some fields stub. base: depends on host providing argv/env |
| `util` | ◐ | ◐ | ✓ | ◐ | ✓ | ◐ | ✓ | `util.types.isProxy` partial (#!~debt) |
| **Strings & paths** | | | | | | | | |
| `path` | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |
| `querystring` | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |
| `string_decoder` | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |
| `url` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | edgejs-web: native URL cache for blob: trampoline |
| `punycode` | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |
| **Streams** | | | | | | | | |
| `stream` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Lib code |
| **Crypto** | | | | | | | | |
| `crypto` | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ◐ | edgejs-web: lib + `crypto-host-random`, `crypto-via-subtle`, host-worker hash/HMAC. StackBlitz: `createHmac` broken (#31, 2021), AES-256-CBC broken (#1571, Oct 2024) |
| **Filesystem** | | | | | | | | |
| `fs` | ✓ | ◐ | ✓ | ✓ | ✓ | ✗ | ✓ | base: full fs via WASI host. edgejs-web: read via SAB ring; OPFS write deferred. Bun: 92% Node-suite |
| `fs/promises` | ✓ | ◐ | ✓ | ✓ | ✓ | ✗ | ✓ | Same backing as `fs` |
| **Network** | | | | | | | | |
| `http` | ?(host) | ◐ | ✓ | ◐ | ◐ | — | ✓ | base: depends on WASI host network. edgejs-web: inbound via SW; outbound throws by default. Bun: outgoing client body buffered |
| `https` | ?(host) | ◐ | ✓ | ◐ | ◐ | — | ✓ | Delegated to http; TLS context inspection works in edgejs-web |
| `http2` | ?(host) | ? | ◐ | ◐ | ◐ | — | ✓ | Untested; Bun: 95% gRPC-suite (not Node-suite) |
| `net` | ?(host) | ⊘ | ✓ | ✓ | ◐ | — | ◐ | base: WASIX has TCP. edgejs-web: `sock_connect` returns ENOSYS. StackBlitz: localhost only |
| `dgram` | ?(host) | ✗ | ✓ | ✓ | ◐ | — | ✗ | UDP — edgejs-web not implemented; StackBlitz no UDP. Bun: >90% Node-suite |
| `tls` | ◐ | ◐ | ◐ | ◐ | ◐ | — | ◐ | Universally partial |
| `dns` | ?(host) | ? | ✓ | ✓ | ◐ | ✗ | ✓ | base: depends on WASI host; edgejs-web untested. Bun: >90% Node-suite |
| **Concurrency** | | | | | | | | |
| `worker_threads` | ?(host) | ◐ | — | ◐ | ◐ | — | ◐ | base: depends on WASI threads. edgejs-web: phase 1 via `worker-threads-per-thread`. StackBlitz: `unref` bug (#365), no synchronous message passing |
| `child_process` | ?(host) | ◐ | — | ◐ | ✓ | — | ✓ | base: depends on host proc spawning. edgejs-web: `child-process-via-executor` policy |
| `cluster` | ?(host) | — | — | ◐ | ✗ | — | — | base: depends on host fd-passing. edgejs-web: architecturally impossible |
| **Time** | | | | | | | | |
| `timers` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Lib + libuv shim |
| `timers/promises` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Lib code |
| `perf_hooks` | ◐ | ◐ | ◐ | ◐ | ◐ | — | ✓ | Partial like everyone — needs audit |
| **OS / terminal** | | | | | | | | |
| `os` | ✓ | ◐ | ◐ | ✓ | ◐ | — | ✓ | base: full os from WASI. edgejs-web: some values stubbed. Bun: 100% Node-suite |
| `tty` | ?(host) | ⊘ | ⊘ | ✓ | ◐ | — | ⊘ | base: depends on host stdin; edgejs-web stubbed |
| `readline` | ?(host) | ? | ⊘ | ✓ | ✓ | — | ✓ | base/edgejs-web: depends on stdin handling |
| `readline/promises` | ?(host) | ? | ⊘ | ✓ | ✓ | — | ✓ | Same |
| **Debug / instrumentation** | | | | | | | | |
| `async_hooks` (ALS) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AsyncLocalStorage works |
| `async_hooks` (promise hooks) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Universally weak (`#!~debt` no-op) |
| `diagnostics_channel` | ✓ | ? | ✓ | ✓ | ✓ | ✗ | ✓ | base: pure JS, inherits Node. edgejs-web: needs verification |
| `inspector` | ✗ | ✗ | ✗ | ⊘ | ✗ | ✗ | ✗ | Rare in production |
| `trace_events` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Universally skipped |
| `v8` | ◐ | ◐ | ⊘ | ◐ | ◐ | ✓ | ✓ | `v8.serialize`/`deserialize` shipped (real wire format); other APIs stub |
| **Compression** | | | | | | | | |
| `zlib` | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | edgejs-web: `zlib-writestate-wasm` policy. Bun: 98% Node-suite |
| **Module system** | | | | | | | | |
| `module` (CJS) | ✓ | ✓ | ◐ | ✓ | ✓ | ✗ | ✓ | Standard CJS works |
| `module` (ESM) | ◐ | ◐ | ◐ | ✓ | ✓ | ✗ | ✓ | base: depends on host import. edgejs-web: full `import` + dynamic + TLA + cycles via blob trampoline; `require(esm)` partial via b₁/b₄ (NOT real wasm-V8 ModuleWrap) |
| `vm` | ◐ | ◐ | ⊘ | ◐ | ◐ | ✗ | ✓ | edgejs-web: `vm.Script` via `new Function`; `vm.SourceTextModule` works via ESM bridge |
| **Niche** | | | | | | | | |
| `repl` | ?(host) | — | ⊘ | ✗ | ✗ | ✗ | ✓ | base: depends on host terminal. edgejs-web: no terminal in browser. StackBlitz: xterm-backed |
| `sea` | — | — | ✗ | ✗ | ✗ | ✗ | ✗ | Not applicable |
| `sqlite` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | Would need Wasm SQLite binding. StackBlitz: Node 22.5+ ships it |
| `wasi` | — | — | ✗ | ◐ | ✗ | — | ✓ | We ARE wasi |
| `domain` | ✓ | ? | ⊘ | ◐ | ✗ | ✗ | ✓ | Deprecated in Node; works in real Node |
| **Native addons (.node)** | ?(host) | — | — | — | — | — | ✗ | base: depends on host addon support. edgejs-web: would need wasm-compiled addons. StackBlitz: `--no-addons` |

## How we compare

**Closest in architectural shape**: Bun, Deno, StackBlitz — all run a real Node-compat runtime. Cloudflare Workers and Vercel Edge are intentionally minimal serverless shapes.

**Where we lead**:
- ESM in browser (real blob-URL trampoline, cycles, TLA, dynamic, source-phase) — most runtimes either inherit Node's impl or don't support it
- `v8.serialize` / `deserialize` byte-exact with Node's V8 wire format
- IPC structured-clone advanced mode (`child-process-via-executor`)

**Where we trail**:
- HTTP/sockets/dgram — universally supported in Bun/Deno; we have it deferred
- `worker_threads` — phase 1 only; full feature parity not yet
- OPFS-backed `fs` write — deferred
- `async_hooks` promise hooks — universally weak (we match the floor)

**Architectural can't-dos** (same as Bun/Deno except where noted):
- `cluster` (fd-passing not available in browser; **we match all serverless-shaped runtimes here**)
- `sea` (single-executable applications)
- `repl` (no terminal)
- `wasi` from user code (we're the runtime, not a guest)
- `sqlite` (no host binding)

## Methodology for filling in this table

Each cell should be verifiable. For edge.js:
- ✓ = at least one test in `tests/js/` exercises the module's main API surface and passes
- ◐ = some tests pass; documented `#!~debt` markers exist for remaining gaps
- ⊘ = import doesn't throw, but key APIs return immediately or throw
- ✗ = import throws or returns empty exports

For other runtimes, status comes from their published compat tables (sources below). We don't independently verify them.

## What's not in this table

- **Web APIs** (`fetch`, `Response`, `crypto.subtle`, `WebSocket`, `URL`, `TextEncoder`, etc.) — every runtime here supports these; tracking would just be a row of ✓s.
- **Globals** (`process`, `Buffer`, `console`, etc.) — covered by their corresponding module rows.
- **npm package compatibility** — orthogonal to module-by-module compat. Bun and StackBlitz install real npm packages; edge.js doesn't have a package install story today (architectural gap, but not module compat).

## Sources

**Per-runtime compat docs**:
- [Cloudflare Workers Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) — clean color-coded table
- [Bun Node.js Compatibility](https://bun.sh/docs/runtime/nodejs-apis) — most detailed, per-module Node-suite pass rates
- [Deno Node APIs Reference](https://docs.deno.com/runtime/reference/node_apis/) — three-bucket categorization
- [Deno Node Test Viewer (live)](https://node-test-viewer.deno.dev/) — live aggregate pass rate dashboard
- [Vercel Edge Runtime APIs](https://edge-runtime.vercel.app/features/available-apis) — short allowlist (Edge Functions deprecated; Edge Middleware only)

**StackBlitz / WebContainers — no per-module compat matrix is published**:
- [WebContainers Troubleshooting](https://webcontainers.io/guides/troubleshooting) — categorical limits (no native addons, no raw TCP/UDP, no custom SW)
- [WebContainers AI-Agents test suite](https://webcontainers.io/guides/ai-agents) — framework-first behavioral tests; Node built-ins are one bucket
- [StackBlitz Developer FAQ](https://developer.stackblitz.com/guides/user-guide/general-faqs)
- GitHub issues are the de facto tracker:
  - [#31](https://github.com/stackblitz/webcontainer-core/issues/31) `crypto.createHmac` broken since 2021
  - [#1571](https://github.com/stackblitz/webcontainer-core/issues/1571) AES-256-CBC broken (Oct 2024)
  - [#365](https://github.com/stackblitz/webcontainer-core/issues/365) `worker_threads.unref` bug
  - [#1558](https://github.com/stackblitz/webcontainer-core/issues/1558) Node version pinning unsupported
- [Astro WebContainer post](https://blog.stackblitz.com/posts/astro-support/) — confirms "synchronous message passing is not supported"

**edge.js (this repo)**:
- `tests/js/*` — green tests indicate working API surface
- `browser-target/src/policies/*.ts` — compensating implementations
- `#!~debt` markers across `browser-target/src/` — documented gaps
- `NOTES.md` — Active tech-debt catalog

## Updating this doc

- Status changes when a `#!~debt` marker is added/removed or a test lands
- StackBlitz column entries come from troubleshooting carve-outs + filed GitHub issues; default-assume ✓ for modules where real Node works and no carve-out / bug is documented
- Bun's per-module test-pass rates evolve; re-fetch quarterly
- Add new modules when Node adds them (e.g. `node:sqlite` shipped in 22.5)
- Surprises worth flagging:
  - Bun's `http` has NO percentage — only a caveat about outgoing client body buffering
  - Bun's `http2` 95% is from gRPC's suite, not Node's (apples-to-oranges)
  - StackBlitz hides known broken algos behind GitHub issues — no advisory in the troubleshooting doc
