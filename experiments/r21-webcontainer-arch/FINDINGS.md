# R21: WebContainer architecture (public-sources research)

**Date:** 2026-05-24
**Scope:** how StackBlitz's WebContainer implements `worker_threads.Worker`,
filesystem sharing, and overall topology.  WebContainer source is closed
— this is assembled from blog posts, podcast transcripts, GitHub issues,
and reverse-engineering articles.  Confirmed vs. inferred called out.

## Architecture (best public reconstruction)

```
Browser tab (cross-origin-isolated)
├── Main thread: JS host, UI, WC public API, MessagePort plumbing
├── Service Worker: virtual TCP / HTTP request interception
├── Web Workers (one per "Node process"):
│     ├── WASM module (kernel/runtime + Rust VFS bindings)
│     ├── Each process == its own Worker
│     └── All Workers share one SharedArrayBuffer for the FS + IPC
└── JS engine: V8 (Chromium) or SpiderMonkey (Firefox/Safari).
      Node has been ported off V8-only so it can run on SpiderMonkey.
```

Confirmed building blocks: Rust VFS, WASI-compiled binaries, WASM-
compiled runtime, Service Worker networking, SharedArrayBuffer +
atomics for FS/IPC.

## Answers to design questions

### 1. What runs where

- **Main thread**: WC public API (`WebContainer.boot()`, `spawn()`,
  `fs.*`) and orchestrates Workers.
- **Service Worker**: intercepts requests to preview URLs, routes into
  in-tab virtual TCP stack.
- **User code**: every spawned "process" runs in a dedicated Web Worker
  hosting a WASM kernel/runtime.  (Bolt/PostHog writeup is the clearest
  confirmation.)
- **Node**: the *runtime* (C++ bits) is compiled to WASM, but JS
  execution itself rides on the *host browser's* JS engine via V8
  isolates (Chromium) or SpiderMonkey (Firefox/Safari).  They explicitly
  moved Node off V8-only — confirmed in the Syntax #404 interview.

### 2. `worker_threads.Worker`

Public statements (Sharp/libvips port post is the gold source):

- WC implements `new worker_threads.Worker(...)` with Node-compliant
  *synchronous* spawn semantics — they consider this an "obscure" Node
  detail worth matching.
- **Mechanism: pre-queue the Worker bootstrap messages BEFORE the
  parent thread enters a blocking wait**, so the child consumes them
  when it actually starts.  The browser Worker still spawns on the next
  task, but the API looks synchronous.  ← THIS IS THE KEY TRICK
- "WebContainers already run user code in Workers" — implies user
  `worker_threads` are mapped 1:1 onto Web Workers, not multiplexed.
- Per-spawn overhead: not numerically documented.  Implied non-trivial.
- Ref/unref edge cases caused real bugs (issue #365: `worker.once`
  implicitly re-ref'd; fixed).  Implies their event-loop ref counter is
  a hand-rolled JS shim, not native libuv.
- No public statement on `MessageChannel`/`MessagePort` transfer-list
  parity; assume best-effort parity since Sharp depended on it.
- **Isolation**: each Web Worker is its own JS realm, so user code gets
  a fresh context.

### 3. Cross-worker filesystem

- All processes (Workers) share one SharedArrayBuffer holding FS state;
  reads/writes happen directly in shared memory, coordinated with
  `Atomics`.  (PostHog "How Bolt.new works".)
- Stated rationale: zero JSON marshalling, no IndexedDB/OPFS async
  hops.
- The Rust kernel inside each Worker enforces locking/atomic
  invariants (Syntax #404).
- This is *the* reason WC requires cross-origin isolation — SAB is
  unusable without COOP/COEP.

### 4. Resource limits

- No documented per-tab cap on the number of `worker_threads`.  Real
  ceiling is tab memory and Worker startup cost.
- Documented failure mode: `RangeError: WebAssembly.instantiate(): Out
  of memory: Cannot allocate Wasm memory for new instance` — hit when
  too many `WebAssembly.Memory` instances are created.  Originally a V8
  1 TiB virtual-address-space cap; lifted in Chrome 96.
- StackBlitz still self-rations how many independent WASM modules they
  bundle.

### 5. Public caveats

- **Cross-origin isolation required**: `Cross-Origin-Embedder-Policy:
  require-corp` (or `credentialless`) + `Cross-Origin-Opener-Policy:
  same-origin`.  Breaks OAuth/Stripe popups.
- **Browser support**: Chromium first; Firefox 119+ once credentialless
  landed; Safari only in 2024+ (older iOS unsupported).
- **No native C/C++ addons** — only WASM-compiled ones (`--no-addons`
  default).
- **Can't ship your own Service Worker**; theirs owns the slot
  (issue #846).
- **Engine drift**: SpiderMonkey vs. V8 differences (stack-trace API,
  Date parsing, atomics codegen on Apple Silicon) are real and must be
  polyfilled per-engine ("Atomic Waltz").

## What edgejs should steal vs. avoid

**Steal:**
- One Web Worker per Node `worker_threads.Worker`, each Worker running
  a WASM kernel against shared linear memory.
- SAB-backed VFS so cross-Worker FS access is synchronous and lock-free
  at the JS layer.
- The "queue Worker bootstrap messages before blocking" trick to fake
  Node's synchronous Worker construction on top of the browser's async
  spawn.

**Avoid:**
- Hand-rolling ref/unref bookkeeping at the JS layer (#365 shows how
  fragile that is — wire it into the same loop primitives that drive
  libuv timers/IO).
- Over-bundling WASM modules per instance (memory pressure is the
  dominant scaling limit, not CPU).
- Assuming Chrome-only — pick portable atomics/idioms from day one.

## Open questions (couldn't determine from public sources)

- Exact `MessagePort` transferable-list parity with Node — `ArrayBuffer`
  transfer or always cloned?  Nested ports?
- Whether WC reuses a Worker pool across short-lived `worker_threads`
  or always spawns fresh.
- Concrete per-spawn latency budget (ms); whether they pre-warm
  Workers. → E24 measures
- How code/eval flows into a freshly spawned Worker (blob URL?  inline
  string?  signed?).
- Whether `Worker.terminate()` actually reclaims SAB regions or leaks
  per process.
- Cooperative vs. preemptive scheduling between Workers under the WC
  kernel — public material implies cooperative.

## Sources

- Bringing Sharp to WASM/WebContainers — worker_threads sync spawn:
  https://blog.stackblitz.com/posts/bringing-sharp-to-wasm-and-webcontainers/
- Introducing WebContainers:
  https://blog.stackblitz.com/posts/introducing-webcontainers/
- WebContainer API:
  https://blog.stackblitz.com/posts/webcontainer-api-is-here/
- Cross-Browser support with COOP/COEP:
  https://blog.stackblitz.com/posts/cross-browser-with-coop-coep/
- The Atomic Waltz — V8 vs SpiderMonkey WASM atomics:
  https://blog.stackblitz.com/posts/the-atomic-waltz/
- Chasing Memory Bugs through V8 and WebAssembly:
  https://blog.stackblitz.com/posts/debugging-v8-webassembly/
- Syntax #404 transcript — Tomek Sulkowski:
  https://syntax.fm/show/404/web-containers-stackblitz-and-node-js-in-the-browser-with-tomek-sulkowski/transcript
- PostHog "How Bolt.new works":
  https://newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech
- webcontainers.io
- mizchi reverse-engineering "What is WebContainer?":
  https://zenn.dev/mizchi/articles/webcontainer?locale=en
- Issue #365 — worker.once implicit ref bug:
  https://github.com/stackblitz/webcontainer-core/issues/365
- Issue #908 — WASM memory instantiate OOM:
  https://github.com/stackblitz/webcontainer-core/issues/908
- Issue #846 — no user service workers:
  https://github.com/stackblitz/webcontainer-core/issues/846
