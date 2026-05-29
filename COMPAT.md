# Node.js Built-in Module Compatibility

Living document tracking which Node.js built-in modules work in edge.js's
browser-target, with a side-by-side reference against other Node-compat
runtimes. Goal: be honest about what works, what's partial, what's stubbed,
and what we don't intend to ship.

**Last updated**: 2026-05-30.

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

**StackBlitz column note**: WebContainers runs a real Node binary
under WASI in a Service Worker, so most modules work by default
unless an architectural carve-out or known bug applies. They
publish no per-module matrix; cells reflect (a) categorical limits
from their troubleshooting page, (b) known bugs from their public
GitHub issue tracker, (c) `(assumed ✓)` for modules where Node
itself would work and no carve-out / bug is documented.

| Module | edge.js | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|
| **Core** | | | | | | | |
| `assert` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Pure JS; Bun: 100% Node-suite |
| `buffer` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Heavy work + `buffer-wasm-aliased` policy |
| `console` | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | Routed to host-worker logs |
| `events` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Pure JS; Bun: 100% Node-suite |
| `process` | ◐ | ◐ | ◐ | ◐ | ◐ | ✓ | `process-methods-wasm-state` policy carries it; some fields stub |
| `util` | ◐ | ✓ | ◐ | ✓ | ◐ | ✓ | `util.types.isProxy` partial (#!~debt) |
| **Strings & paths** | | | | | | | |
| `path` | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |
| `querystring` | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |
| `string_decoder` | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |
| `url` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Lib + native URL cache for blob: trampoline |
| `punycode` | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |
| **Streams** | | | | | | | |
| `stream` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Lib code |
| **Crypto** | | | | | | | |
| `crypto` | ✓ | ✓ | ◐ | ✓ | ✓ | ◐ | Edge: lib + multiple host-routed policies. StackBlitz has known broken algos: `createHmac` (issue #31, since 2021), AES-256-CBC (issue #1571, Oct 2024) |
| **Filesystem** | | | | | | | |
| `fs` | ◐ | ✓ | ✓ | ✓ | ✗ | ✓ | Edge: read via SAB ring; OPFS write deferred. Bun: 92% Node-suite. StackBlitz: full fs from real Node |
| `fs/promises` | ◐ | ✓ | ✓ | ✓ | ✗ | ✓ | Same backing as `fs` |
| **Network** | | | | | | | |
| `http` | ◐ | ✓ | ◐ | ◐ | — | ✓ | Edge: inbound via SW bridge; outbound throws. Bun: outgoing client body buffered (no streaming). StackBlitz: real Node http |
| `https` | ◐ | ✓ | ◐ | ◐ | — | ✓ | Edge: delegated to http; TLS context inspection works (`tls-info`, `tls-secure-context` tests pass) |
| `http2` | ? | ◐ | ◐ | ◐ | — | ✓ | Edge: untested. Bun: 95% gRPC-suite (not Node-suite) |
| `net` | ⊘ | ✓ | ✓ | ◐ | — | ◐ | Edge: `sock_connect` returns ENOSYS. StackBlitz: TCP listen works for localhost, raw TCP to outside world blocked per troubleshooting |
| `dgram` | ✗ | ✓ | ✓ | ◐ | — | ✗ | Edge: UDP not implemented. Bun: >90% Node-suite. StackBlitz: no UDP per troubleshooting |
| `tls` | ◐ | ◐ | ◐ | ◐ | — | ◐ | Universally partial — full TLS in browser is hard |
| `dns` | ? | ✓ | ✓ | ◐ | ✗ | ✓ | Edge: lib code exists, untested. Bun: >90% Node-suite |
| **Concurrency** | | | | | | | |
| `worker_threads` | ◐ | — | ◐ | ◐ | — | ◐ | Edge: phase 1 via `worker-threads-per-thread` policy. StackBlitz: `unref` bug (#365), synchronous message passing not supported (Astro blog confirms esbuild forced to use child_process) |
| `child_process` | ◐ | — | ◐ | ✓ | — | ✓ | Edge: `child-process-via-executor` policy. StackBlitz: real Node child_process |
| `cluster` | — | — | ◐ | ✗ | — | — | Architecturally impossible: no socket-sharing across processes in browser |
| **Time** | | | | | | | |
| `timers` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Lib + libuv shim |
| `timers/promises` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Lib code |
| `perf_hooks` | ◐ | ◐ | ◐ | ◐ | — | ✓ | Edge: partial like everyone — needs audit |
| **OS / terminal** | | | | | | | |
| `os` | ◐ | ◐ | ✓ | ◐ | — | ✓ | Edge: lib code; some OS-specific values stubbed. Bun: 100% Node-suite |
| `tty` | ⊘ | ⊘ | ✓ | ◐ | — | ⊘ | Likely stub — no real terminal in browser |
| `readline` | ? | ⊘ | ✓ | ✓ | — | ✓ | Edge: depends on stdin handling, untested |
| `readline/promises` | ? | ⊘ | ✓ | ✓ | — | ✓ | Same |
| **Debug / instrumentation** | | | | | | | |
| `async_hooks` (ALS) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AsyncLocalStorage works |
| `async_hooks` (promise hooks) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Universally weak (`#!~debt` no-op) |
| `diagnostics_channel` | ? | ✓ | ✓ | ✓ | ✗ | ✓ | Edge: lib code exists; needs verification |
| `inspector` | ✗ | ✗ | ⊘ | ✗ | ✗ | ✗ | Rare in production |
| `trace_events` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Universally skipped |
| `v8` | ◐ | ⊘ | ◐ | ◐ | ✓ | ✓ | Edge: `v8.serialize` / `deserialize` shipped (real wire format); other APIs stub. StackBlitz: real Node V8 module |
| **Compression** | | | | | | | |
| `zlib` | ✓ | ✓ | ✓ | ✓ | — | ✓ | `zlib-writestate-wasm` policy; `zlib-bundled-gzip` test green. Bun: 98% Node-suite |
| **Module system** | | | | | | | |
| `module` (CJS) | ✓ | ◐ | ✓ | ✓ | ✗ | ✓ | Standard CJS works |
| `module` (ESM) | ◐ | ◐ | ✓ | ✓ | ✗ | ✓ | Edge: full `import` + dynamic + TLA + cycles via blob trampoline; `require(esm)` partial via b₁ cache + b₄ Sucrase backstop (NOT real wasm-V8 ModuleWrap) |
| `vm` | ◐ | ⊘ | ◐ | ◐ | ✗ | ✓ | Edge: `vm.Script` via `new Function`; `vm.SourceTextModule` works via ESM bridge. StackBlitz: real V8 vm module |
| **Niche** | | | | | | | |
| `repl` | — | ⊘ | ✗ | ✗ | ✗ | ✓ | Edge: no terminal in browser. StackBlitz: works in their xterm-backed terminal |
| `sea` | — | ✗ | ✗ | ✗ | ✗ | ✗ | Single-executable apps — not applicable |
| `sqlite` | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | Would need Wasm SQLite binding. StackBlitz: included since Node 22.5 ships it |
| `wasi` | — | ✗ | ◐ | ✗ | — | ✓ | Edge: we ARE wasi. StackBlitz: real Node WASI |
| `domain` | ? | ⊘ | ◐ | ✗ | ✗ | ✓ | Deprecated in Node, but still works in real Node |
| **Native addons (.node)** | — | — | — | — | — | ✗ | StackBlitz: `--no-addons` per troubleshooting. Edge: would need wasm-compiled addons, not supported today |

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
