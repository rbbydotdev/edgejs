# R22: wasm-runtime-in-browser threading survey

**Date:** 2026-05-24
**Scope:** how language-runtime-in-wasm projects (other than emnapi and
WebContainer, covered separately by R20/R21) handle multi-threading via
spawning Workers.  Research only.

## Per-project summaries

**Pyodide (Python in wasm via Emscripten).** Python's `threading` module
is unsupported; pyodide explicitly tells users to use a Web Worker per
Python "thread".  *Each worker re-instantiates the entire Pyodide
runtime* — no shared interpreter, no shared globals between workers or
main.  Recommended pattern: warm a long-lived worker pool eagerly at
boot, preload packages, dispatch via `postMessage`.  C-level pthreads
(Emscripten, COOP/COEP) do work but only for C extension code; never
runs Python.

**Emscripten pthreads (the substrate everyone uses).**  Each pthread =
one dedicated Web Worker, **same wasm module + SharedArrayBuffer**.  Two
big knobs:
- `PTHREAD_POOL_SIZE` pre-spawns workers at preRun so `pthread_create`
  is synchronous — without it, create-then-immediately-join deadlocks
  because workers can't be created while JS/wasm is running.
- `PROXY_TO_PTHREAD` moves `main()` off the main browser thread so
  `Atomics.wait` is legal.

Documented gotchas: `ALLOW_MEMORY_GROWTH + pthreads` is slow and breaks
external `Module.HEAP*` access; dlmalloc has a single global lock; no
POSIX signals (only `pthread_kill`); file I/O is proxied to main.  Pool
sizing matters — user-reported: 2 pooled workers ≈ 200 MB, 20 pooled
≈ 400 MB in Chrome.

**wasi-threads & shared-everything-threads.** wasi-threads is now
*legacy* (kept only for WASI 0.1).  The future is the
"shared-everything-threads" proposal (component-model builtins for
thread spawn, shared flag on globals/tables/funcs).  On the web,
Workers stay the underlying primitive — shared-everything-threads is
polyfilled on Workers.  Years away from real shipping.

**php-wasm / WordPress Playground.** *Deliberately ships without
pthreads* — issue #347 records the team's decision that no
WordPress-relevant code needs threads.  Their blocking-call strategy is
**Asyncify everywhere** plus a service worker for HTTP.  Anti-pattern
for our needs (Node code DOES expect real worker_threads).

**ruby.wasm.** Threading not enabled in the browser build.  Ruby's GVL
means parallel Ruby needs Ractors anyway, and ruby.wasm doesn't ship
Ractor-on-Worker.  Fibers work in-process (cooperative,
single-threaded).  Not a useful model for us.

**Bun-in-browser.** Does not exist.  Bun depends on uSockets / JSC
native bindings; no public wasm port.

**Asyncify vs JSPI.** Asyncify: binaryen rewrites wasm to make calls
unwindable/rewindable — ~50% size+perf overhead, works everywhere.
JSPI: V8/SpiderMonkey-level stack switching, constant-time
suspend/resume, but **JS→wasm async calls are 2 orders of magnitude
slower than Asyncify** (Emscripten #21081).  JSPI shipped Chrome 137,
Firefox 139 in 2025.  **JSPI does not give you threads** — only
suspension on one stack.  Orthogonal to worker_threads.

## Patterns & anti-patterns

| Project | Pattern / Anti-pattern | Apply to edgejs? |
|---|---|---|
| Pyodide | Warm long-lived worker pool, preload at boot | YES — pre-spawn N idle workers; `new Worker()` dispatch ≈ O(1) |
| Pyodide | Each worker = fresh full runtime (no shared interpreter) | YES — matches Node worker_threads per-Worker-isolate exactly |
| Emscripten | `PTHREAD_POOL_SIZE` pre-allocation | PARTIAL — emnapi internals; user-visible `Worker()` stays async |
| Emscripten | `PROXY_TO_PTHREAD` (main on a worker) | ALREADY DONE — we run wasm on a worker, main thread is just a router |
| Emscripten | `ALLOW_MEMORY_GROWTH + pthreads` slow path | AVOID — generous initial memory; document growth cost |
| Emscripten | dlmalloc global lock | WATCH — switch to mimalloc if contention shows up |
| Emscripten | Pool size = memory cost (20 workers ≈ 400 MB) | KEY CONSTRAINT — cap default pool, expose `maxWorkers` |
| Emscripten | No POSIX signals on workers | OK — `Worker.terminate()` → `worker.terminate()` |
| php-wasm | Skip pthreads entirely; Asyncify everything | ANTI for us — Node code expects real worker_threads |
| ruby.wasm | Don't ship threads at all | ANTI for us — same reason |
| All | Require COOP/COEP for SharedArrayBuffer | MANDATORY — already a known edge constraint |
| All | Main thread cannot `Atomics.wait` | ALREADY KNOWN — drives our host-RPC design |
| Pyodide & php-wasm | Cold-start per worker = full runtime load | RISK — mitigate via pre-spawned idle pool sharing a compiled `WebAssembly.Module` (transferable) |

## Synthesis

**Consensus across Pyodide, Emscripten, and the WASI WG**: in the
browser **a runtime "thread" = a Web Worker holding its own wasm
instance, talking via `SharedArrayBuffer` + `Atomics`**.  No one ships
true in-process multi-isolate — every project either pre-spawns a pool
(Emscripten pthreads), spins per-call workers (Pyodide), or skips
threading (php-wasm, ruby.wasm).

**edge.js should adopt:**
1. One Web Worker per Node `Worker` (1:1 mapping, matches per-Worker
   isolate semantics).
2. Share the compiled `WebAssembly.Module` via `postMessage`
   transferable to skip recompile.
3. Keep a small pre-warmed idle pool (default ≤ 2) to hide cold-start.
4. `PROXY_TO_PTHREAD`-equivalent already done.
5. Hard-cap default pool and document the ~200 MB/worker baseline.

The hardest unsolved part is `MessagePort` / transferable semantics
between Workers — none of these projects implement Node's transferable
model; we'll need a custom marshaller on top of `postMessage` (we
already have `cross-context-marshal.ts` from E16 to extend).

## Open questions for E24/E25

1. Can we share one compiled `WebAssembly.Module` across N Workers
   without recompile cost?  Spec says yes via transferable; need to
   measure. → E24
2. Cold-start budget per Worker for edge's wasm size — no public
   Pyodide numbers; must measure ourselves. → E24
3. Does `PROXY_TO_PTHREAD`-style "main on a worker" compose with our
   existing host-RPC `Atomics.wait` design, or fight it? → E25
4. Node `MessagePort` transfer between Workers: tunnel via main (slow)
   or direct `BroadcastChannel`-style path? → phase 4 design

## Sources

- https://pyodide.org/en/stable/usage/webworker.html
- https://pyodide.org/en/stable/usage/wasm-constraints.html
- https://yosefk.com/blog/enabling-c-threads-in-a-python-wasm-environment.html
- https://emscripten.org/docs/porting/pthreads.html
- https://github.com/emscripten-core/emscripten/issues/14407
- https://github.com/emscripten-core/emscripten/issues/21081
- https://github.com/WebAssembly/shared-everything-threads
- https://github.com/WebAssembly/wasi-threads
- https://2025.wasm.io/sessions/threading-the-needle-with-concurrency-and-parallelism-in-the-component-model/
- https://github.com/WordPress/wordpress-playground/issues/347
- https://wordpress.github.io/wordpress-playground/developers/architecture/wasm-php-overview/
- https://v8.dev/blog/jspi
- https://developer.chrome.com/blog/webassembly-jspi-origin-trial
