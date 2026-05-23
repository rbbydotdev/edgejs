# WebContainer (StackBlitz) — architectural findings

Research conducted 2026-05-23. Full agent output in
`/private/tmp/claude-501/.../tasks/a8664d7feb4276396.output`.

## Architectural shape

**WebContainer is NOT Node-in-wasm.** They:
- Wrote a Rust micro-OS kernel, compiled to wasm
- Run user JavaScript on the browser's native V8 (or SpiderMonkey on Firefox)
- Implemented Node's `node:*` module surface as custom TypeScript on the host
- Communicate kernel↔JS via SharedArrayBuffer + Atomics for sync syscalls
- Use Service Worker on a per-project preview origin to virtualize TCP `listen()`
- Dropped libuv entirely — use browser's event loop

Eric Simons: *"any JavaScript that's being executed is actually being run by
the browser's version of V8."* They use *"a WebAssembly operating system layer
that actually provides those services"* — namely the OS-shaped parts of Node.

## Topology

- **Main page**: thin client; the WebContainer JS API
- **Service Worker** on a separate `*.webcontainer.io` per-project origin: virtualizes TCP via fetch interception
- **N DedicatedWorkers**, one per spawned "process"; each has its own wasm kernel + runs user JS on its own V8 isolate
- Tried single-Worker first — UI froze under load; Web Worker per process was the fix

## What they explicitly chose

1. **Bundle wasm modules aggressively** — they hit V8's 1 TiB pool / 10 GiB-per-memory cap by shipping too many independent modules. Even after Chrome 96 lifted the limit, they kept the consolidation policy.
2. **Service Worker + per-project origin for `listen()`** — only browser API that intercepts iframe-src loads. WebSocket/WebTransport can't do this.
3. **SAB + Atomics for sync syscalls** — only way to make `fs.readFileSync` work in browser without rewriting every package as async.
4. **No `.node` addons; mandate wasm equivalents** — `--no-addons` is hardcoded. emnapi is the de-facto N-API-over-wasm shim they piggyback on (Sharp port etc.).
5. **Service Worker owns the network adapter slot** — user code cannot register custom SWs.
6. **Drop libuv; use browser's event loop** — explicit simplification.
7. **Custom TypeScript module loader** — not a port of Node's. Faster to iterate but accumulates module-resolution edge cases over years (issue #1137 unfixed since 2023).

## Known limitations / pain points (from their issues + docs)

- ESM/CJS interop edge cases (#1137) — they reimplemented the resolver and still have bugs
- `process.platform` returns `'linux'`, `process.arch` returns `'x64'` — they lie. Breaks napi-rs native-fallback distribution (#1460).
- `postinstall` scripts don't run
- iOS memory-constrained
- Native addons hard-disabled with no path
- Cross-origin isolation politics — COEP-credentialless took 18+ months to land
- Each wasm Memory still costs significant V8 address space

## Edge.js's path forward

WebContainer's approach inverts Node-in-wasm vs. wasm-as-kernel. Edge.js's
current architecture is closer to Node-in-wasm. Lever B converges us toward
WebContainer's pattern WITHOUT losing edge.js's value proposition:

- **WebContainer**: re-implemented Node's surface in TS, accepting accumulated
  semantic bugs as cost-of-doing-business
- **Edge.js post-Lever-B**: keep Node's real `lib/*.js` source as the
  authority, just have it run on host V8 (not wasm V8)

Lever B's worker split achieves WebContainer's "user JS on host V8" pattern
incidentally — `unofficial_napi_contextify_run_script` already uses
`new Function(code)`, which evaluates in whatever worker's V8 the napi-host
runs on. Moving napi-host to the host worker = moving user JS to host V8.

## Definite DOs (lessons we steal)

1. Bundle wasm modules — don't ship N independent ones
2. COOP/COEP from day 1; plan Firefox + Safari with credentialless mode
3. SAB + Atomics for any sync syscall path
4. Per-project preview origin for SW scope isolation in iframe-src scenarios
5. Use emnapi (already do)
6. Service Worker owns network adapter slot (already do)
7. OPFS for opt-in persistence; ephemeral default
8. Don't trust user code to register Service Workers
9. Bundle Node's lib/* into the host worker bundle

## Definite DON'Ts (mistakes to avoid)

1. **DON'T re-implement Node's ESM resolver from scratch.** Use Node's real lib/.
2. **DON'T lie about `process.platform`/`process.arch`.** Be honest — `wasm` arch, `browser` platform. Be the better citizen so napi-rs ecosystem can route around us.
3. **DON'T promise FS persistence by default.** OPFS is opt-in.
4. **DON'T virtualize TCP `listen()` in same-origin.** Per-project preview origin or bust.
5. **DON'T do filesystem in pure JavaScript.** Their first attempt froze; Rust+wasm+SAB worked.
6. **DON'T promise raw TCP outbound.** WebSocket relay later if needed.
7. **DON'T require user-registered Service Workers.**
8. **DON'T launch Firefox/Safari without COEP-credentialless.**

## Hard truths

- Custom Node compatibility is *years* of work. WebContainer spent ~7 years.
- ESM resolver is a known multi-year tar pit — they have unfixed bugs from 2023.
- Native addons are an immutable browser-sandbox constraint.

## Sources

- [JS Party #178 — Running Node natively in the browser](https://changelog.com/jsparty/178)
- [Syntax #404 — Web Containers with Tomek Sulkowski](https://syntax.fm/show/404)
- [PostHog — How bolt.new works](https://newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech)
- [Introducing WebContainers](https://blog.stackblitz.com/posts/introducing-webcontainers/)
- [Bringing Sharp to WASM/WebContainers](https://blog.stackblitz.com/posts/bringing-sharp-to-wasm-and-webcontainers/)
- [Chasing Memory Bugs through V8](https://blog.stackblitz.com/posts/debugging-v8-webassembly/)
- [Cross-Browser support COOP/COEP](https://blog.stackblitz.com/posts/cross-browser-with-coop-coep/)
- [WebContainer API site](https://webcontainers.io/)
- WebContainer-core issue tracker (closed-source impl, public issues)
