# Node.js Built-in Module Compatibility

Living document tracking which Node.js built-in modules work across
edge.js's deployment surfaces, with a side-by-side reference against
other Node-compat runtimes. Goal: be honest about what works, what's
partial, what's stubbed, and what we don't intend to ship.

**Last updated**: 2026-05-30.

**edgejs-web pass rates** come from a sampled run of Node's
upstream test corpus (`test/parallel/*.js`) against browser-target via
`browser-target/scripts/node-corpus-scaled.mjs` — ~311 tests across
22 module families, sampled (not the full 3961). Bun-style. See
[`corpus/corpus-summary.md`](corpus/corpus-summary.md) for the
detailed table and [`corpus/corpus-results.json`](corpus/corpus-results.json)
for per-test outcomes. Rerun with `cd browser-target && node scripts/node-corpus-scaled.mjs`.

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
(green = supported), `browser-target/src/edge-env/presets/*` (compensating
presets — the typed framework that replaced `src/policies/` on 2026-05-30),
and `browser-target/src/napi-host/unofficial.ts` `#!~debt` markers (known
gaps).

**Honesty + recovery arc (2026-05-30 / 2026-05-31):**

Three-step arc.

(1) The `process.exit` patch (2026-05-30) caused test scripts to actually
terminate (previously silent), which surfaced 87 of 178 corpus failures
as `common.mustCall(fn, N)` mismatches — tests where async event
handlers never fire because our libuv-wasix `poll_oneoff` parks in
`Atomics.wait` for up to ~30s with no JS-side wake.  Honest overall
pass rate dropped from inflated 71% to honest **43%**.

(2) The `poll-wake-on-schedule` preset (2026-05-30) added the missing
wake source: wraps `internalBinding('timers').scheduleTimer` and
`toggleImmediateRef` to call `globalThis.__edgeWakePoll()` after
scheduling, immediately interrupting any parked `poll_oneoff`.
Corpus rose to **50%**.

(3) The lean `buildDriver` fix (2026-05-30 evening) discovered a
~2150-char URL-encoding length cliff in the script transport that was
masquerading as a "natural drain doesn't work" issue.  With the driver
URL-encoded under the cliff, the libuv loop drains naturally end-to-end
— stream 'end'/'close' fires, mustCall verifiers register correct
counts, beforeExit triggers correct exit.  Then a sweep of focused
typed presets across the deferred-but-not-architectural surface:
string-decoder full WHATWG UTF-8 impl (0→100%), util binding fixes
(60→68%), zlib brotli init-params sync (75→87%), os priority stateful
(57→71%).  **Final 2026-05-31: 65% (202/311).**

**Internal tracking via `browser-target/known-failures.json` manifest:**
each known-failing test is annotated with a category (deferred-fs,
deferred-net, deferred-child-process, deferred-vm-cross-realm,
inspector-not-supported, v8-natives, asynclocalstorage-promise-hooks,
etc.) so the runner can surface regression alerts:
KNOWN-FAIL-CHANGED (a known-fail's signature changed — investigate),
UNEXPECTED-PASS (a known-fail now passes — remove from manifest).  The
public pass rate above is RAW only — failures stay in the denominator
because each one documents a real gap.

Standing rules:
1. Never stub a binding/method just to make a test pass — honest
   failures beat dishonest passes.
2. Don't quote "adjusted" pass rates that exclude failures from the
   denominator — same shape of dishonesty (a broken test is
   documentation of a missing feature; removing it from the metric
   hides the gap).  Raw rates only.

See memory rule `feedback-no-stubs-to-pass-tests`.

## Side-by-side compat

**Column notes**:
- **edgejs** (base) — most cells reflect "inherits Node's lib + C++ binding"; pure-JS modules are ✓ by default. Network, FS, and process behavior depend on the WASI(X) host. Cells marked `?(host)` mean "depends on host capability; not exhaustively tested in our CI."
- **edgejs-web** — the browser-target distribution; cells reflect current `main` per `tests/js/`, policies, and `#!~debt` markers.
- **StackBlitz** — no per-module matrix is published. Cells reflect (a) categorical limits from their troubleshooting page, (b) known bugs from public GitHub issues, (c) statements from StackBlitz engineering in 2024-2026 (PostHog interview Sep 2025, Verschueren GitHub comments Feb 2026, Astro / Next.js framework integration commits). They run **Node 20.19.x** as of early 2026 (per Astro's Jan 2026 commit hardcoding `process.versions.webcontainer >=20.19.1`); anything requiring Node 22+ features (`node:sqlite`, `require(esm)`) is therefore not available. They explicitly use **emnapi + Emscripten** for NAPI (Sharp post 2023-08-03), don't publicly use JSPI, and have a custom Rust-based fs + Web-Workers-as-processes architecture (PostHog 2025-09-16) — this means several "Node module" cells route through their custom Rust kernel rather than Node's libuv, with the spec gaps that implies. Cells marked `?` are unknown; ✓ marks pure-JS Node modules they presumably inherit, ◐ where they've publicly admitted gaps, ✗ where they've publicly disabled (`--no-addons`) or where the Node version locks them out.

### Core

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `assert` | ✓ | ✓ 94% | ✓ | ✓ | ✓ | ✓ | ✓ | edgejs-web: 17/18 — 1 failing test depends on V8 Error.prepareStackTrace (not implemented) |
| `buffer` | ✓ | ◐ 70% | ✓ | ✓ | ✓ | ✓ | ✓ | edgejs-web: 14/20 — buffer-base64 (vendored unenv decoder), buffer-copy (TypedArray.set), vm-same-realm. Remaining: utf-8 surrogate handling, wasm-aliased + external-ArrayBuffer, V8-internal on-heap typed-array, child_process JSPI dependencies |
| `console` | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | edgejs-web: routed to host-worker logs |
| `events` | ✓ | ✓ 92% | ✓ | ✓ | ✓ | ✓ | ✓ | edgejs-web: 33/36 — big jump (was 36%) from `util-get-own-non-index-properties` preset (root-cause fix for assert.deepStrictEqual on Arrays). 3 failures: 2 deep-chain captureRejections (exceeds drain watchdog), 1 corpus-driver harness conflict with uncaughtException |
| `process` | ◐ | ◐ 67% | ◐ | ◐ | ◐ | ◐ | ✓ | edgejs-web: 10/15 — `process-methods-wasm-state` + cpuUsage validation. Remaining: 3 deferred (fs/net/child_process) + 1 inspector (no-stub policy: honest failure) + 1 beforeexit chain |
| `util` | ◐ | ◐ 68% | ✓ | ◐ | ✓ | ◐ | ✓ | edgejs-web: 17/25 — `util-get-own-non-index-properties` + `util-get-constructor-name` (registry through setPrototypeOf) + `util-get-proxy-details` + `util-types-async-gen`. Remaining: V8-internals, vm cross-realm |

### Strings & paths

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `path` | ✓ | ✓ 100% | ✓ | ✓ | ✓ | — | ✓ | edgejs-web: 16/16. Pure JS |
| `querystring` | ✓ | ✓ 100% | ✓ | ✓ | ✓ | — | ✓ | edgejs-web: 3/3. Pure JS |
| `string_decoder` | ✓ | ✓ 100% | ✓ | ✓ | ✓ | — | ✓ | edgejs-web: 2/2 — fixed via `string-decoder-js` preset: real WHATWG-correct UTF-8 decoder (~440 LOC) replacing the wasm `utf8Slice` that returned garbage surrogate pairs for ill-formed UTF-8. Also overrides `internalBinding('buffer').{utf8,ucs2,ascii,latin1,hex,base64,base64url}Slice` — bonus: Buffer.toString improvements across encodings |
| `url` | ✓ | ✓ 93% | ✓ | ✓ | ✓ | ✓ | ✓ | edgejs-web: 13/14 — 1 failing test uses child_process.spawn for a deprecation-warning subprocess assertion |
| `punycode` | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | Pure JS; Bun: 100% Node-suite |

### Streams

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `stream` | ✓ | ✓ 70% | ✓ | ✓ | ✓ | ✓ | ✓ | edgejs-web: 14/20 — natural-drain via lean buildDriver fix unlocked the stream events. Remaining 6 are deferred (net/http for createServer; abort-signal interop for compose) |

### Crypto

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `crypto` | ✓ | ◐ 40% | ✓ | ◐ | ✓ | ✓ | ◐ | edgejs-web: 6/15 — `crypto-host-random`, `crypto-via-subtle`, host-worker hash/HMAC presets. Remaining 9 all OpenSSL-specific (Argon2, ECDH curves, PEM, SPKAC) or fs-deferred. StackBlitz: `createHmac` broken (#31, 2021), AES-256-CBC broken (#1571, Oct 2024) |

### Filesystem

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `fs` | ✓ | ◐ 33% | ✓ | ✓ | ✓ | ✗ | ◐ | edgejs-web: 5/15 measured — matches "read works, write deferred" story. base: full fs via WASI host. Bun: 92% Node-suite. StackBlitz: custom Rust fs over SAB+Atomics (PostHog 2025) — NOT Node's libuv fs |
| `fs/promises` | ✓ | ◐ | ✓ | ✓ | ✓ | ✗ | ◐ | Same backing as `fs` |

### Network

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `http` | ?(host) | ◐ 13% | ✓ | ◐ | ◐ | — | ✓ | edgejs-web: 2/15 (honest; was inflated to 80%) — most failures are mustCall-on-async, plus real socket bindings unimplemented. base: depends on WASI host network. Bun: outgoing client body buffered |
| `https` | ?(host) | ◐ | ✓ | ◐ | ◐ | — | ✓ | Delegated to http; TLS context inspection works in edgejs-web |
| `http2` | ?(host) | ? | ◐ | ◐ | ◐ | — | ✓ | Untested; Bun: 95% gRPC-suite (not Node-suite) |
| `net` | ?(host) | ⊘ | ✓ | ✓ | ◐ | — | ◐ | base: WASIX has TCP. edgejs-web: `sock_connect` returns ENOSYS. StackBlitz: localhost only |
| `dgram` | ?(host) | ✗ | ✓ | ✓ | ◐ | — | ✗ | UDP — edgejs-web not implemented; StackBlitz no UDP. Bun: >90% Node-suite |
| `tls` | ◐ | ◐ | ◐ | ◐ | ◐ | — | ◐ | Universally partial |
| `dns` | ?(host) | ? | ✓ | ✓ | ◐ | ✗ | ✓ | base: depends on WASI host; edgejs-web untested. Bun: >90% Node-suite |

### Concurrency

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `worker_threads` | ?(host) | ◐ 20% | — | ◐ | ◐ | — | ◐ | edgejs-web: 3/15 — `worker-threads-per-thread` + cross-thread wake bridge. Most failures involve deeper worker lifecycle (cpu-profile, terminate, etc.) |
| `child_process` | ?(host) | ⊘ 30% | — | ◐ | ✓ | — | ✓ | edgejs-web: 3/10 — `child-process-via-executor` ships an executor-based path. Real sub-wasm spawn via supervisor-worker IS architecturally ready (host-worker.ts + Atomics.wait-safe sync RPC + spawnUserWorker) — ~80 LOC of integration away from `spawnSync(process.execPath, [...])` working. Task #177 |
| `cluster` | ?(host) | — | — | ◐ | ✗ | — | — | base: depends on host fd-passing. edgejs-web: architecturally impossible |

### Time

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `timers` | ✓ | ◐ 73% | ✓ | ✓ | ✓ | ✓ | ✓ | edgejs-web: 11/15 — most timer paths working via poll-wake-on-schedule. Remaining 4 are unrelated subsystems (AsyncLocalStorage promise hooks, V8 natives, child_process, domain) |
| `timers/promises` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Lib code |
| `perf_hooks` | ◐ | ◐ 70% | ◐ | ◐ | ◐ | — | ✓ | edgejs-web: 7/10. Remaining 3 = V8 native syntax + ELU precision + full hdrhistogram impl |

### OS / terminal

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `os` | ✓ | ◐ 71% | ◐ | ✓ | ◐ | — | ✓ | edgejs-web: 5/7 — `os-priority-stateful` preset adds setPriority/getPriority. Remaining 2: V8 natives + child_process. base: full os from WASI. Bun: 100% Node-suite |
| `tty` | ?(host) | ⊘ | ⊘ | ✓ | ◐ | — | ⊘ | base: depends on host stdin; edgejs-web stubbed |
| `readline` | ?(host) | ? | ⊘ | ✓ | ✓ | — | ✓ | base/edgejs-web: depends on stdin handling |
| `readline/promises` | ?(host) | ? | ⊘ | ✓ | ✓ | — | ✓ | Same |

### Debug / instrumentation

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `async_hooks` (ALS) | ✓ | ◐ 30% | ✓ | ✓ | ✓ | ✓ | ◐ | edgejs-web: 3/10. AsyncLocalStorage works for `.then()` chains; gap is `async/await` + promise-hooks. Universal browser-Node-runtime gap (StackBlitz too — Verschueren #1169, 2026-02-12) |
| `async_hooks` (promise hooks) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Universally weak (`#!~debt` no-op). StackBlitz publicly admits this same gap |
| `diagnostics_channel` | ✓ | ? | ✓ | ✓ | ✓ | ✗ | ? | base: pure JS, inherits Node. StackBlitz: untested but inherits Node 20 |
| `inspector` | ✗ | ✗ | ✗ | ⊘ | ✗ | ✗ | ✗ | Rare in production |
| `trace_events` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Universally skipped |
| `v8` | ◐ | ◐ | ⊘ | ◐ | ◐ | ✓ | ? | `v8.serialize`/`deserialize` shipped (real wire format); other APIs stub. StackBlitz: no public statement; unknown |

### Compression

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `zlib` | ✓ | ◐ 53% | ✓ | ✓ | ✓ | — | ✓ | edgejs-web: 8/15 — recovered from 33% by poll-wake-on-schedule. `zlib-writestate-wasm` preset. Bun: 98% Node-suite |

### Module system

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `module` (CJS) | ✓ | ✓ | ◐ | ✓ | ✓ | ✗ | ✓ | Standard CJS works. StackBlitz uses custom TS resolver (PostHog 2025-09-16) |
| `module` (ESM) | ◐ | ◐ | ◐ | ✓ | ✓ | ✗ | ◐ | base: depends on host import. edgejs-web: full `import` + dynamic + TLA + cycles via blob trampoline; `require(esm)` partial via b₁/b₄. StackBlitz: ESM works but `require(esm)` (Node 22.12+) NOT available — still on Node 20.19 in 2026 |
| `vm` | ◐ | ⊘ 7% | ⊘ | ◐ | ◐ | ✗ | ? | edgejs-web: 1/15 measured — `vm.Script` via `new Function` covers only basic code; break-on-sigint, timeout, real Context isolation all missing. `vm.SourceTextModule` works via ESM bridge but it's a small slice of the test corpus. StackBlitz: no public statement; presumably similar V8-bounded ceiling |

### Niche

| Module | edgejs | edgejs-web | Cloudflare | Bun | Deno | Vercel Edge | StackBlitz | Notes |
|---|---|---|---|---|---|---|---|---|
| `repl` | ?(host) | — | ⊘ | ✗ | ✗ | ✗ | ✓ | base: depends on host terminal. edgejs-web: no terminal in browser. StackBlitz: xterm-backed |
| `sea` | — | — | ✗ | ✗ | ✗ | ✗ | ✗ | Not applicable |
| `sqlite` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | `node:sqlite` requires Node 22.5+. StackBlitz: still on Node 20.19 as of 2026, so NOT available |
| `wasi` | — | — | ✗ | ◐ | ✗ | — | ✓ | We ARE wasi |
| `domain` | ✓ | ? | ⊘ | ◐ | ✗ | ✗ | ✓ | Deprecated in Node; works in real Node |
| `Native addons (.node)` | ?(host) | — | — | — | — | — | ✗ | base: depends on host addon support. edgejs-web: would need wasm-compiled addons. StackBlitz: `--no-addons` confirmed still in 2026 — they ship wasm ports (Sharp, etc.) via emnapi + Emscripten instead |

## How we compare

**Closest in architectural shape**: Bun, Deno run real V8 from their own native binary — they have full V8 C++ API access. StackBlitz runs Node's C/C++ in wasm but **without V8 in the wasm** (Eric Simons JS Party #178, 2021; never refuted in 2024-2026 sources). They bridge V8 calls back to the browser's JS — same surface ceiling we have. Cloudflare Workers and Vercel Edge are intentionally minimal serverless shapes.

## What we learn from StackBlitz's 2025-2026 architecture

This section is based on the deep-dive research dispatched 2026-05-30 — primary sources cited inline. Headline: their architecture has NOT meaningfully changed since 2021. What changed is polish + a pivot onto Bolt.new on top of the same runtime.

**What they do** (PostHog "How bolt.new works" 2025-09-16, with CTO Albert Pai + founding engineer Dominic Elm):
- File system: custom Rust over SharedArrayBuffer + Atomics (not Node's libuv fs)
- Process model: Web Workers as processes with a custom Rust kernel
- Networking: Service Worker virtual localhost; WebSocket tunneling for raw TCP
- Module system: custom Node-style ESM/CJS resolver in TypeScript (not Node's loader)
- Shell: custom JSH (TypeScript shell), not bundled Bash
- NAPI: emnapi + Emscripten with `WASM_ASYNC_COMPILATION=0` (Sharp post 2023)
- Threading: pthreads via Web Workers + SharedArrayBuffer + wasm-bindgen
- Node version: **20.19.x** as of early 2026 (no `require(esm)`, no `node:sqlite`)
- async_hooks: AsyncLocalStorage works for `.then()` chains; **explicitly broken for native `async/await`** per Sam Verschueren on issue #1169 (2026-02-12): "we can't know when a promise is scheduled or resolved" without transpilation
- Native addons: `--no-addons` still in 2026; pure-JS or wasm-port-via-emnapi the only paths

**Decisions we should EMULATE**:
1. **Custom TS resolver over Node's loader** — we already do this in `browser-target/src/policies/`; confirmed correct direction.
2. **Service-Worker-served stable module URLs** for cyclic-graph cases — we already did this in commit `c0b22aa5`; PostHog confirms their preview/module bridging is still this pattern.
3. **Sync wasm compile (`WASM_ASYNC_COMPILATION=0` equivalent)** — avoids worker-pool deadlocks during native module init. Worth checking our emnapi config.
4. **Be publicly honest about gaps**. Verschueren's Feb 2026 admission that AsyncLocalStorage doesn't work for native `async/await` is the most candid framing we've seen from any Node-in-browser project. Our `NOTES.md` debt catalog is in this spirit; keep it.
5. **emnapi + Emscripten for native modules** — pragmatic path of least surprise for porting addons. If we add native-module support, this is the path.

**Decisions we should AVOID**:
1. **Lagging the Node version by 2-3 years.** They're on Node 20 in mid-2026 when 24 is LTS. Framework authors are forced to write detect-and-relax shims (Astro's Jan 2026 `process.versions.webcontainer >=20.19.1` is the smoking gun). **Our full-Node-compat-first principle is correct.**
2. **Promising native addons while shipping `--no-addons`** — three years on, still their position. Be honest.
3. **Not publishing a per-module compat matrix.** Their lack of one creates documented user frustration (issues #1978, #2065, #1169). This COMPAT.md is intentionally different.

**Where we genuinely lead**:
- ESM `require(esm)` partial support via b₁/b₄ — StackBlitz doesn't have it (Node version locked).
- Real V8 wire format `v8.serialize`/`deserialize` — neither StackBlitz nor most others ship this.
- JSPI — StackBlitz hasn't publicly used it. We have a real architectural advantage here for sync-suspending APIs.

**Where they genuinely lead**:
- FS / network breadth — they shipped these as custom Rust impls year 1; we deferred.
- Practical npm install / framework integration story — Bolt.new gives them real-world feedback loops we don't have.
- Process model — Web Workers as processes is shipping; our `worker-threads-per-thread` is phase 1.

**Genuinely unknown** (research couldn't find):
- Their `vm` module specifics — no 2024+ source addresses it.
- Whether they use JSPI under the hood for anything.
- Their child_process internals when called from inside a wasm Node binary.
- Whether `worker_threads.Worker` is real shared-memory or sequential simulation in 2026.

This matters for modules that need V8 internals:
- **edgejs / edgejs-web / StackBlitz**: all bounded by what V8 exposes to JS. `vm` break-on-sigint, `vm` timeout, real `vm.Context` isolation, `v8` heap APIs — none of us can do these without going to extreme lengths (iframes for context isolation, etc.).
- **Bun / Deno**: real C++ V8 access via their native binaries — they CAN do these.

We're not behind StackBlitz on V8-bounded features; we're roughly the same. Where we trail StackBlitz is FS/network because they shipped those modules first and we deferred them.

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

**StackBlitz / WebContainers — no per-module compat matrix is published**.

Primary 2024-2026 sources:
- [PostHog "How bolt.new works"](https://newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech) 2025-09-16 — direct quotes from CTO Albert Pai + founding engineer Dominic Elm. Most architecturally explicit recent source.
- [WebContainers Troubleshooting](https://webcontainers.io/guides/troubleshooting) — categorical limits (no native addons, no raw TCP/UDP, no custom SW)
- [WebContainers AI-Agents test suite](https://webcontainers.io/guides/ai-agents) — framework-first behavioral tests; Node built-ins are one bucket
- [StackBlitz Developer FAQ](https://developer.stackblitz.com/guides/user-guide/general-faqs)
- [Joan Varvenne interview "Beyond Docker"](https://blog.stackblitz.com/posts/beyond-docker-webcontainers-and-the-future-of-web-dev-interview-with-joan-varvenne/) 2024-05-31

GitHub issues:
- [#31](https://github.com/stackblitz/webcontainer-core/issues/31) `crypto.createHmac` broken since 2021
- [#1571](https://github.com/stackblitz/webcontainer-core/issues/1571) AES-256-CBC broken (Oct 2024)
- [#365](https://github.com/stackblitz/webcontainer-core/issues/365) `worker_threads.unref` bug (fixed)
- [#1558](https://github.com/stackblitz/webcontainer-core/issues/1558) Node version pinning unsupported (Oct 2024, Node 18.20.3 era)
- [#1169](https://github.com/stackblitz/webcontainer-core/issues/1169) AsyncLocalStorage — Verschueren comment 2026-02-12 admits `async/await` gap
- [#1767](https://github.com/stackblitz/webcontainer-core/issues/1767) Node 20 bump signal (March 2025)
- [#1978](https://github.com/stackblitz/webcontainer-core/issues/1978) Next.js ≥15.5/16 broken (Sep 2025–Feb 2026)
- [#2065](https://github.com/stackblitz/webcontainer-core/issues/2065) Turbopack wasm bindings broken (March 2026)

Architecture posts (2023, still authoritative per 2025-2026 research):
- [Bringing Sharp to WebAssembly](https://blog.stackblitz.com/posts/bringing-sharp-to-wasm-and-webcontainers/) 2023-08-03 — confirms emnapi + Emscripten, `WASM_ASYNC_COMPILATION=0`
- [The Atomic Waltz](https://blog.stackblitz.com/posts/the-atomic-waltz/) 2023-05-11 — SharedArrayBuffer threading details
- [Destroyer of Threads](https://blog.stackblitz.com/posts/thread-destroyer/) 2023-03-07 — pthreads via Web Workers + wasm-bindgen

External calibration (Node version detect-and-relax in framework code):
- Astro Jan 2026 commit hardcoding `process.versions.webcontainer >=20.19.1`

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
