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

| Module | edge.js | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|
| **Core** | | | | | | | |
| `assert` | ✓ | ✓ | ✓ | ✓ | ✓ | ? | Pure JS |
| `buffer` | ✓ | ✓ | ✓ | ✓ | ✓ | ? | Heavy work + `buffer-wasm-aliased` policy |
| `console` | ✓ | ◐ | ✓ | ✓ | ✓ | ? | Routed to host-worker logs |
| `events` | ✓ | ✓ | ✓ | ✓ | ✓ | ? | Lib code |
| `process` | ◐ | ◐ | ◐ | ◐ | ◐ | ? | `process-methods-wasm-state` policy carries it; some fields stub |
| `util` | ◐ | ✓ | ◐ | ✓ | ◐ | ? | `util.types.isProxy` partial (#!~debt) |
| **Strings & paths** | | | | | | | |
| `path` | ✓ | ✓ | ✓ | ✓ | — | ? | Pure JS, no syscalls |
| `querystring` | ✓ | ✓ | ✓ | ✓ | — | ? | Pure JS |
| `string_decoder` | ✓ | ✓ | ✓ | ✓ | — | ? | Pure JS |
| `url` | ✓ | ✓ | ✓ | ✓ | ✓ | ? | Lib + native URL cache for blob: trampoline |
| **Streams** | | | | | | | |
| `stream` | ✓ | ✓ | ✓ | ✓ | ✓ | ? | Lib code |
| **Crypto** | | | | | | | |
| `crypto` | ✓ | ✓ | ◐ | ✓ | ✓ | ? | Lib + `crypto-host-random`, `crypto-via-subtle`, hash/HMAC via host worker |
| **Filesystem** | | | | | | | |
| `fs` | ◐ | ✓ | ✓ | ✓ | ✗ | ? | Read via SAB ring works; OPFS write deferred (`#!~debt opfs-not-yet-persistent`) |
| `fs/promises` | ◐ | ✓ | ✓ | ✓ | ✗ | ? | Same backing as `fs` |
| **Network** | | | | | | | |
| `http` | ◐ | ✓ | ✓ | ◐ | — | ? | Inbound via SW bridge; outbound throws (`outbound-throw` default) or fetch-tunnels (`outbound-fetch-tunnel` opt-in). Single-listener, no chunked, no keep-alive |
| `https` | ◐ | ✓ | ◐ | ◐ | — | ? | Delegated to http; TLS context inspection works (`tls-info`, `tls-secure-context` tests pass) |
| `http2` | ? | ◐ | ◐ | ◐ | — | ? | Untested |
| `net` | ⊘ | ✓ | ✓ | ◐ | — | ? | `sock_connect` returns ENOSYS; listen path partial |
| `dgram` | ✗ | ✓ | ✓ | ◐ | — | ? | UDP — not implemented |
| `tls` | ◐ | ◐ | ◐ | ◐ | — | ? | Context inspection only; full TLS server not implemented |
| `dns` | ? | ✓ | ✓ | ◐ | ✗ | ? | Lib code exists, untested |
| **Concurrency** | | | | | | | |
| `worker_threads` | ◐ | — | ◐ | ◐ | — | ? | Phase 1 shipped via `worker-threads-per-thread` policy; some gaps remain |
| `child_process` | ◐ | — | ◐ | ✓ | — | ? | `child-process-via-executor` policy; sendHandle limited (`#!~debt child-process-ipc-sendhandle`), kill cooperative-only |
| `cluster` | — | — | ◐ | ✗ | — | — | Architecturally impossible: no socket-sharing across processes in browser |
| **Time** | | | | | | | |
| `timers` | ✓ | ✓ | ✓ | ✓ | ✓ | ? | Lib + libuv shim |
| `timers/promises` | ✓ | ✓ | ✓ | ✓ | ✓ | ? | Lib code |
| `perf_hooks` | ◐ | ◐ | ◐ | ◐ | — | ? | Partial like everyone — needs audit |
| **OS / terminal** | | | | | | | |
| `os` | ◐ | ◐ | ✓ | ◐ | — | ? | Lib code; some OS-specific values stubbed |
| `tty` | ⊘ | ⊘ | ✓ | ◐ | — | ? | Likely stub — no terminal in browser |
| `readline` | ? | ⊘ | ✓ | ✓ | — | ? | Depends on stdin handling |
| `readline/promises` | ? | ⊘ | ✓ | ✓ | — | ? | Same |
| **Debug / instrumentation** | | | | | | | |
| `async_hooks` (ALS) | ✓ | ✓ | ✓ | ✓ | ✓ | ? | AsyncLocalStorage works |
| `async_hooks` (promise hooks) | ✗ | ✗ | ✗ | ✗ | ✗ | ? | Universally weak (`#!~debt` no-op) |
| `diagnostics_channel` | ? | ✓ | ✓ | ✓ | ✗ | ? | Lib code exists; needs verification |
| `inspector` | ✗ | ✗ | ⊘ | ✗ | ✗ | ? | Rare in production |
| `trace_events` | ✗ | ✗ | ✗ | ✗ | ✗ | ? | Universally skipped |
| `v8` | ◐ | ⊘ | ◐ | ◐ | ✓ | ? | `v8.serialize` / `deserialize` shipped (real wire format); other APIs stub |
| **Compression** | | | | | | | |
| `zlib` | ✓ | ✓ | ✓ | ✓ | — | ? | `zlib-writestate-wasm` policy; `zlib-bundled-gzip` test green |
| **Module system** | | | | | | | |
| `module` (CJS) | ✓ | ◐ | ✓ | ✓ | ✗ | ? | Standard CJS works |
| `module` (ESM) | ◐ | ◐ | ✓ | ✓ | ✗ | ? | Full `import` + dynamic + TLA + cycles via blob trampoline; `require(esm)` partial via b₁ cache + b₄ Sucrase backstop (NOT real wasm-V8 ModuleWrap) |
| `vm` | ◐ | ⊘ | ◐ | ◐ | ✗ | ? | `vm.Script` via `new Function`, no break-on-sigint; `vm.compileFunction` approximation; `vm.SourceTextModule` works via ESM bridge |
| **Niche** | | | | | | | |
| `repl` | — | ⊘ | ✗ | ✗ | ✗ | — | No terminal in browser |
| `sea` | — | ✗ | ✗ | ✗ | ✗ | — | Single-executable apps — not applicable |
| `sqlite` | ✗ | ✗ | ✗ | ✗ | ✗ | ? | Would need Wasm SQLite binding |
| `wasi` | — | ✗ | ◐ | ✗ | — | — | We ARE wasi |
| `domain` | ? | ⊘ | ◐ | ✗ | ✗ | ? | Deprecated in Node |

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

- [Cloudflare Workers Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Bun Node.js Compatibility](https://bun.sh/docs/runtime/nodejs-apis)
- [Deno Node APIs Reference](https://docs.deno.com/runtime/reference/node_apis/)
- [Deno Node Test Viewer (live)](https://node-test-viewer.deno.dev/)
- [Vercel Edge Runtime APIs](https://edge-runtime.vercel.app/features/available-apis)
- [WebContainers Introduction](https://webcontainers.io/guides/introduction)
- edge.js: this repo's `tests/js/*`, `browser-target/src/policies/*.ts`, `#!~debt` markers across `browser-target/src/`.

## Updating this doc

- Status changes when a `#!~debt` marker is added/removed or a test lands
- StackBlitz column starts as `?` — no per-module compat table is published; populate from behavioral observations or community reports
- Bun's per-module test-pass rates evolve; consider re-fetching quarterly
- Add new modules when Node adds them (e.g. `--experimental-sqlite` is now `node:sqlite`)
