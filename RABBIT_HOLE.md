# Rabbit-Hole Snapshot — 2026-05-21

You stopped here to come back later.  This file is the full context you need
to resume — what's outstanding, what we learned, what we tried, where things
sit, what the priorities are.  It's deliberately long.  Skim the Table of
Contents and dive into whatever's relevant when you return.

> **Where to start when you come back:**
> Read this file → skim [NOTES.md](./NOTES.md) → check `git log` for what
> happened after this snapshot → pick one item from "Pause Inventory" below.

## Table of Contents

1. [Project state at pause](#project-state-at-pause)
2. [Why we paused](#why-we-paused) — the rabbit-hole moment
3. [The 4 underlying bugs surfaced by fetch-tunnel](#the-4-underlying-bugs)
   - [#1 sab-ab-body-read](#1-sab-ab-body-read)
   - [#2 lazy-load-from-microtask](#2-lazy-load-from-microtask)
   - [#3 microtasks-starved-by-pending-timer](#3-microtasks-starved-by-pending-timer)
   - [#4 buffer-from-string-zeroed](#4-buffer-from-string-zeroed)
4. [Recommended investigation order](#recommended-investigation-order)
5. [Pause Inventory — what's outstanding](#pause-inventory)
   - [Half-done in this session](#half-done-in-this-session)
   - [Big chunks never started](#big-chunks-never-started)
   - [Smaller debts (52 `#!~debt` markers)](#smaller-debts)
6. [Architecture re-orientation](#architecture-re-orientation)
7. [Your stated rules (don't forget)](#your-stated-rules)
8. [Investigation toolkit — useful commands](#investigation-toolkit)

---

## Project state at pause

**Goal:** run unmodified edge.js (a Node-compatible runtime) inside a
browser via WebAssembly.  StackBlitz-grade Node compat.

**Branch:** `main`, ~24 commits ahead of `origin/main`.

**Last commit:** `c369dc61` — "policies: ship outbound-fetch-tunnel; test
skipped on 4 underlying debts"

**Test suite:** 12 pass, 0 fail, 0 error, 2 skip — via
`node browser-target/scripts/test-runner.mjs`.

**Capability matrix (see [NOTES.md](./NOTES.md) for full table):**

- ✅ Boot, console, process.exit, timers
- ✅ `http.createServer` + fetch roundtrip via SW bridge
- ✅ `crypto` (sha256, randomBytes, randomUUID, …)
- ✅ Module-source overrides (universal — bootstrap + lazy)
- ✅ TLS primitives + `https.createServer` + listen
- ✅ Policies DI framework with sane defaults
- ✅ Inbound HTTPS via SW bridge (https-as-http policy)
- ⚠️  Outbound HTTPS — `outbound-fetch-tunnel` policy SHIPPED but test
       blocked on the 4 bugs below
- ❌ `import` / ESM — never started (you asked to investigate `xnitro`
       in `../localwin` first)
- ❌ OPFS persistence (in-memory only)
- ❌ `worker_threads`, `child_process`

**Last several commits, newest first:**

```
c369dc61 policies: ship outbound-fetch-tunnel; test skipped on 4 underlying debts
0f103b74 policies: expose minimalPolicies + policyRegistry; clarify default lineage
b237e4b6 policies: extract a deployment-time strategy DI framework
5e09a346 overrides: bake https→http into the browser worker
949185a3 tests: add TLS/HTTPS smoke tests; document the roundtrip gap
94c6122f tests: add Node-side regression runner over tests/js/*
5188f64e napi: close override-bootstrap-only debt — intercept napi_run_script too
e9367aa8 napi: add universal module-source override hook (partial — bootstrap only)
332cb40b notes: reset NOTES.md to a curated scannable index, archive history
e3ad1153 fs: ModuleOverrides adapter — consumer-pluggable Node built-ins (scoped)
```

---

## Why we paused

You asked me to build the `outbound-fetch-tunnel` policy (the opt-in
shortcut for `http.request` / `https.request` over `globalThis.fetch`)
before consulting on ESM strategy.

The policy CODE turned out to be straightforward — wire `Writable` to
collect chunks, `await fetch(...)`, expose response as an EventEmitter.
But **getting it to actually run end-to-end uncovered four distinct
underlying compatibility bugs** in our edge.js+wasm host integration.

Each bug is independently real and affects more than just the fetch-tunnel.
They've been silently lurking — only this stress test surfaced them all.
Rather than keep patching workarounds and accumulating ugly polyfill code,
you said:

> "I'm hitting layers of underlying compatibility issues — we might have to
> pause and follow the rabbit hole on this"

That's right.  Each of these bugs deserves its own root-causing pass, not
a band-aid.

---

## The 4 underlying bugs

All four are documented as `#!~debt` markers in `NOTES.md` under
"Boot-blocking / correctness".  Below is the full context that wouldn't
fit in NOTES.

### #1 sab-ab-body-read

**Severity: High.** Affects any use of edge's bundled fetch / Response
in production browser deployment.

**Symptom:**
```
TypeError: Method get ArrayBuffer.prototype.byteLength called on
incompatible receiver #<SharedArrayBuffer>
```

**Minimal repro (Node harness):**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --quiet -e "fetch('http://x').then(r => r.text()).catch(e => console.log(e.message))"
```
Even `new Response('hi').text()` throws the same error.

**Why it happens:**

Our `patchEmnapiToUseWasmBackedBuffers` (in
`browser-target/src/napi-host/index.ts`) makes napi-created ArrayBuffers
backed by wasm memory.  Wasm memory IS a `SharedArrayBuffer` (we need
shared so multiple workers can read the same memory).

When V8/Node runs `ArrayBuffer.prototype.byteLength` on a value, it does
an internal check that the receiver is an `ArrayBuffer` instance (not
`SharedArrayBuffer`).  `byteLength` is a different getter on each class.

Edge's undici fetch internals read `byteLength` via the strict getter
(probably via `%ArrayBufferPrototype%.byteLength.call(buf)` or similar)
when consuming the response body.  Our SAB-backed buffer fails the check.

**What we tried:**
- Mocking fetch with a Response-shape object whose `arrayBuffer()`
  returns a regular `Uint8Array.buffer` (not SAB-backed).  Works for
  the tunnel's IN-process flow but doesn't help when REAL fetch fires
  in production.

**Where to investigate:**
- `browser-target/src/napi-host/index.ts` — search for
  `patchEmnapiToUseWasmBackedBuffers`, especially `napi_create_arraybuffer`
  and `napi_create_buffer` overrides.
- Decision point: should napi-created "ArrayBuffer" handles be:
  - Real `SharedArrayBuffer` (current — fast, no copy, but fails type checks)
  - Real `ArrayBuffer` with bytes copied from wasm memory (slower, but
    spec-compliant)
  - Some hybrid where we present as `ArrayBuffer` to userland but keep
    SAB underneath?
- May need to fork emnapi to handle this — its assumption is that wasm
  memory ArrayBuffer = real ArrayBuffer, which V8 in shared-memory mode
  violates.

**Blast radius:** Anyone using fetch, Response, Request, Blob, FormData,
TextDecoder over wasm-memory bytes, etc.  Probably explains other "silent
read failure" things we haven't noticed yet.

### #2 lazy-load-from-microtask

**Severity: Medium.** Visible whenever async user code uses console.log
with anything that touches lazy console internals.

**Symptom:**
```
TypeError: fn is not a function
    at BuiltinModule.compileForInternalLoader (node:internal/bootstrap/realm:401:7)
    at requireBuiltin (node:internal/bootstrap/realm:432:14)
    at lazyUtilColors (node:internal/console/constructor:84:18)
    at console.value (node:internal/console/constructor:332:17)
```
or with the same root, but from `createWritableStdioStream` →
`requireBuiltin('tty' | 'internal/fs/sync_write_stream' | 'net')`.

**Minimal repro:**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --policies buffer-pool-disable --quiet \
  -e "(async () => { await Promise.resolve(); console.log('a','b'); })();"
```

A bare `await Promise.resolve()` followed by multi-arg `console.log`
triggers it.  Single-arg console.log doesn't (different lazy path).

**What's happening:**

`realm.js:395`:
```js
const fn = compileFunction(id);
fn(this.exports, requireFn, this, process, internalBinding, primordials);
```

`compileFunction` is `internalBinding('builtins').compileFunction` which
in C++ is `BuiltinsCompileFunctionCallback` (edge_module_loader.cc:964).
That C++ callback calls our wasm-imported
`unofficial_napi_contextify_compile_function` — and we have a debug log
in there that **doesn't fire** when this error happens.

So either:
- C++ goes through a different path (cache?) we haven't traced
- Or the call from microtask context is somehow routed to a different
  napi function altogether

**Workaround in place (the silent-init prelude in
`outbound-fetch-tunnel.ts`):**

```js
// Pre-prime BEFORE any await microtask boundary:
process.stdout.fd; process.stderr.fd;  // forces createWritableStdioStream
const _w1 = process.stdout.write, _w2 = process.stderr.write;
process.stdout.write = () => true; process.stderr.write = () => true;
try { console.log('', ''); console.error('', ''); } catch {}
process.stdout.write = _w1; process.stderr.write = _w2;
```

This synchronously triggers lazyUtilColors + lazyInspect + stdio init
so that later microtask continuations find everything already cached.
Works but feels like a band-aid.

**Where to investigate:**
- `browser-target/src/napi-host/unofficial.ts` —
  `unofficial_napi_contextify_compile_function`.  Add an unconditional
  `console.warn` at the top to verify it's called or not from microtask
  contexts.  (Note: console.warn itself might hit the same bug — use
  `writeSync(2, ...)` directly.)
- The C++ side that calls our wasm import:
  `src/edge_module_loader.cc:964` `BuiltinsCompileFunctionCallback`.
  Trace what happens when invoked from `napi_call_function` inside a
  microtask.
- Possibility: emnapi's reference-counting / scope management drops
  some state across microtask boundaries that the C++ callback depends on.

**Why "fn = compileFunction(id)" can come back non-function:**
- `BuiltinsCompileFunctionCallback` returns the `.function` property of
  the compile result object.  If our hook didn't actually set that
  property (e.g. fell through to a stub returning 0), C++ extracts
  `undefined` and returns undefined to JS.
- Try logging on EVERY napi function in `imports-generated.ts` (turn the
  stub recorder into a tap) and look for what fires between the
  `await` and the `fn is not a function` throw.  The culprit napi call
  is probably visible.

### #3 microtasks-starved-by-pending-timer

**Severity: Medium-low.** Test-runner UX issue mostly; might mask other
bugs by making them look like timeouts.

**Symptom:** When a `setTimeout(N)` is pending, no microtasks drain
until the timer fires.  Async/await + setTimeout in the same script
always sees the timer first.

**Minimal repro:**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --quiet -e "
Promise.resolve().then(() => console.log('microtask'));
setTimeout(() => console.log('timer'), 1000);
"
```

In real Node: `microtask` then `timer`.  In our wasm: `timer` then `microtask`
(if `microtask` fires at all before the process exits).

**Why it likely happens:**

Edge's libuv-style event loop in wasm uses our `poll_oneoff` syscall
(`browser-target/src/wasi-shim.ts`).  When the loop has a pending
timer, it calls poll_oneoff with the timer timeout.  Our poll_oneoff
uses `Atomics.wait` against an SAB to block until the timeout OR a
wakeup signal.

**The bug is probably:** the wasm thread blocks on Atomics.wait WITHOUT
giving JS engine a chance to drain microtasks first.  JS microtasks
should drain BEFORE returning to the C event loop.

The JS engine's microtask queue is typically drained after every
"task" (event loop iteration).  In wasm running synchronously inside a
Worker, microtasks drain when the wasm yields back to JS (e.g. via an
import call) — but if the wasm just blocks on Atomics.wait without
returning to JS, microtasks never get scheduled.

**Where to investigate:**
- `browser-target/src/wasi-shim.ts` — find `poll_oneoff`.  Before calling
  `Atomics.wait`, try `queueMicrotask(() => {})` or `await Promise.resolve()`
  to force a microtask drain.  But you can't await inside a sync wasi
  call — that's the whole problem.
- Possible fix: in poll_oneoff, when the wait timeout is non-zero, do
  short Atomics.wait spins (e.g. 1ms each) and between spins yield via
  `setImmediate`/`postMessage` to allow microtask drain.  Tradeoff:
  CPU vs scheduling fidelity.
- Or: cooperate with the wasm such that any pending JS microtasks are
  injected as wakeup signals on the SAB.  Would need wasi-shim awareness
  of the JS microtask queue, which is hard (V8 doesn't expose it).

### #4 buffer-from-string-zeroed

**Severity: HIGH.** Silent data corruption.  Most concerning of the four.

**Symptom:** `Buffer.from('payload-here', 'utf8')` returns a Buffer of
correct LENGTH (12) but all-zero BYTES.  The string→utf8 encoding
**never actually writes into the buffer**.

**Minimal repro from the fetch-tunnel test session:**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --quiet --policies buffer-pool-disable,outbound-fetch-tunnel -e "
const req = require('http').request({method:'POST'});
req.write('payload-here');
console.log('chunks:', req._chunks.map(c => [c.length, c.toString('utf8'), Array.from(c).join(',')]));
req.end();
"
```
Outputs `[ [ 12, '...', '0,0,0,0,0,0,0,0,0,0,0,0' ] ]` — length right,
content wrong.

**Critical question we did NOT answer:**

Our `crypto-sha256.js` test does:
```js
c.createHash('sha256').update('hello').digest('hex')
```
and produces the CORRECT sha256 of "hello".  But sha256 internally must
encode the string to bytes — which means `Buffer.from(str)` or equivalent
must work there.  So why does it work in crypto but not in the fetch
tunnel?

Possibilities:
- Context/realm dependent — fetch-tunnel runs from a microtask context;
  crypto.update runs synchronously.  Maybe Buffer encoding diverges by
  realm.
- Policy interaction — `outbound-fetch-tunnel` policy is active in the
  failing case; `buffer-pool-disable` is in both.  Maybe the prelude
  monkey-patches break Buffer's internal encoder.
- Object-vs-string handoff — when user calls `req.write('payload')`,
  Writable internals might decode the string to a Buffer-via-wasm-pool
  view that immediately gets overwritten.
- Maybe `Buffer.from(string)` actually works fine, and the
  ZERO-ization happens later via Buffer.concat or Writable buffering.

**Investigation steps:**

1. **Direct test in clean context.**  Doesn't touch fetch or http:
   ```bash
   node --experimental-wasm-exnref --import ./node_modules/tsx/dist/loader.mjs \
     scripts/node-harness.mjs --quiet --policies buffer-pool-disable -e "
   const b = Buffer.from('hello', 'utf8');
   console.log('len:', b.length, 'bytes:', Array.from(b).join(','));
   "
   ```
   If this produces zeros, the bug is in `Buffer.from(string)` itself.
   If correct, the bug is downstream (Writable / our _write capture).

2. **With outbound-fetch-tunnel applied but no http use:**
   ```bash
   node ... --policies buffer-pool-disable,outbound-fetch-tunnel -e "
   const b = Buffer.from('hello', 'utf8');
   console.log(b.length, Array.from(b));
   "
   ```
   If still wrong, the fetch-tunnel prelude is corrupting Buffer somehow.

3. **Inside Writable._write, what does chunk look like?**  Add
   diagnostic in `outbound-fetch-tunnel.ts` `_write` to log
   `[chunk.length, chunk[0], chunk[1], ...]` immediately on entry.

4. **Where does crypto encode strings?**  Read `lib/internal/crypto/hash.js`
   to see how `update(str)` converts to bytes.  Likely a different path
   than user-visible Buffer.from.

**Files to read first:**
- `browser-target/src/napi-host/index.ts` — `patchEmnapiToUseWasmBackedBuffers`
  is the obvious suspect.
- `lib/buffer.js` — edge's Buffer impl, especially `Buffer.from`,
  `FastBuffer`, `fromString`.
- `lib/internal/buffer.js` — `utf8Write` and friends.

**Why this is scariest:** silent data corruption.  Anything that does
`Buffer.from(string)` in a context-sensitive way might be writing zeros
without us noticing.  Could be lurking under our HTTP tests if the
strings happen to be empty or test assertions only check length.

---

## Recommended investigation order

If you have time for ONE thing, do **#4 (buffer-from-string-zeroed)**.
The risk of silent corruption beats everything else.

If you have time for two: **#4 then #1 (SAB/AB)** — both are
wasm-memory-data-flow bugs that probably share root cause infrastructure
(our napi_create_buffer overrides) even if symptoms differ.

If you have time for all four: **#4 → #1 → #2 → #3.**  The async-pattern
bugs (#2, #3) are probably layered on top of correct buffer/memory
handling; root-causing them first leads to whack-a-mole.

When fixing each, prefer the real-napi-layer fix (per your stated
preference) over JS-layer polyfill.  The workaround in the fetch-tunnel
prelude (silent console.log pre-init) is acceptable as a temporary
patch but ugly to leave permanent.

---

## Pause Inventory

### Half-done in this session

**`outbound-fetch-tunnel` policy — code ships, test skipped**
- `browser-target/src/policies/outbound-fetch-tunnel.ts` — correctly
  designed Policy.  Test at `tests/js/policy-outbound-fetch-tunnel.js`
  is `.skip`'d with reasons.  Unblocks when #4 or #1 lands.

**ESM investigation never started**
- Per your instructions: "when finish consult me on ESM support, but
  only after you investigate how we did it in the xnitro package in
  ../localwin".  You stopped before I got to it.  When you resume:
  1. Investigate `../localwin/xnitro` (or wherever xnitro lives) to
     see the ESM approach used there.
  2. Report back to YOU, do not start implementing.
  3. Decision on whether to apply same approach to edge.js is yours.

**Test runner has no timeout flag**
- The runner has a hardcoded 30s timeout per test.  Some skipped tests
  (`webserver.js`) would benefit from a per-test override mechanism.

### Big chunks never started

In priority order (from before the pause):

| Chunk | Scope | Why it matters |
|---|---|---|
| **ESM support** (`module_wrap_*`) | 600-1500 LOC, likely needs Asyncify | Most modern code uses `import`; 18 `module_wrap_*` stubs return placeholders.  YOU asked to investigate xnitro first. |
| **OPFS persistence** | ~200-400 LOC + async pre-warm | You said "save for last".  Needed for any stateful app surviving page reload. |
| **worker_threads** | ~300-500 LOC | Each worker = real Web Worker over SAB; niche but unavoidable for some workloads. |
| **Memory hygiene** | ~100-200 LOC | `_malloc`'d buffers never `_free`'d → long-running OOM.  Also: wire `__indirect_function_table` so emnapi finalizers stop silently no-op'ing. |
| **`outbound-via-relay` policy** | ~200-400 LOC + relay infra | "Real" path for outbound (vs polyfill); needs hosted relay. |
| **child_process** | Unknown, large | Browser-incompatible by design. |

### Smaller debts

52+ `#!~debt` markers across `browser-target/`.  Sample of biggest categories:

- **Sockets**: `single-listener`, `single-flight`, `no-keep-alive`,
  `no-chunked-encoding`, `no-outbound`, `no-socketpair`, `no-sendfile`,
  `wake-slot-collisions`, `fake-local-addr`, `fake-peer`, `no-ipv6`
- **FS**: `naïve-stat-via-fetch`, `no-write-support`, `no-readdir`,
  `sync-xhr-network-blocking`
- **napi/unofficial**: many no-op stubs that need promotion when a
  workload lights them up
- **Boot**: `crude-circuit-breaker`, `fake-fs-fallback`,
  `dynCall-before-table-ready`
- **The 4 new ones from this session**: `sab-ab-body-read`,
  `lazy-load-from-microtask`, `microtasks-starved-by-pending-timer`,
  `buffer-from-string-zeroed`

Fix each when a real workload lights it up, not preemptively.  The
exception is `#4 buffer-from-string-zeroed` which is silent corruption
and should be hunted down even without a specific workload demanding it.

---

## Architecture re-orientation

(If you're rusty when you come back, this is the 60-second re-onboard.)

**Two iteration loops:**
- **Node harness** (`browser-target/scripts/node-harness.mjs`) — ~3s
  startup, same code paths as the browser except `fs.readFileSync`
  instead of sync XHR.  Used for fast iteration on napi/wasi/crypto.
- **Browser** (`vite dev` on `:5180`) — ~15s, full end-to-end including
  Service Worker bridge.  Used to verify SW-mediated behaviors.

**Test runner:**
```bash
node browser-target/scripts/test-runner.mjs
```
Iterates `tests/js/*.js`, runs each through the harness with `--quiet`,
compares captured stdout/stderr to sibling `*.stdout` / `*.stderr` files.
`*.skip` files mark skips; `*.harness-args` files add per-test flags
(e.g. `--policies a,b,c`).

**Wasm host shape:**
```
edgejs.wasm  imports →
  wasi_snapshot_preview1, wasix_32v1, wasi  (browser-target/src/wasi-shim.ts)
  napi, env                                  (browser-target/src/napi-host/)
  emnapi                                     (@emnapi/core)
```

**Policies framework** (NEW this session — the DI layer for deployment-
varying behaviors): `browser-target/src/policies/index.ts`.  See the
header comment there for the philosophy.  Default browser stack is
Node-honest (throw on unsupported); shortcuts are explicit opt-ins.

**Where to start reading when investigating any bug:**
- `browser-target/src/wasi-shim.ts` — every WASI syscall, the entire
  socket virtualization, poll_oneoff, fs adapter routing
- `browser-target/src/napi-host/index.ts` — emnapi composition, the
  wasm-backed-buffer patches, the napi_run_script override
- `browser-target/src/napi-host/unofficial.ts` — the 80 unofficial_napi_*
  functions, including the compile_function hook
- `lib/buffer.js` — edge's Buffer impl (vendored Node source)
- `src/edge_module_loader.cc` — edge's C++ side that calls our wasm
  imports.  Not in our repo to modify casually but useful to read.

**The data-flow that matters:**
- Wasm asks for a Buffer → `napi_create_buffer` (overridden) → `_malloc`
  in wasm, returns wasm-backed view via emnapi external-array hook
- Wasm calls JS via `napi_call_function` → emnapi marshalls → handler
  in our host
- Edge's bootstrap modules compiled via
  `unofficial_napi_contextify_compile_function` (we override for module
  source replacement)
- Lazy builtins compiled via `napi_run_script` (we wrap to also do
  module override)

---

## Your stated rules

(Important context for any decision when resuming.)

From `~/.claude/projects/.../memory/` — keep applying:

1. **Full Node compat first** — fix the real napi/wasi layer until edge's
   own implementation works; polyfilling at the JS layer is a fallback,
   not a preferred path.  Especially relevant when investigating the 4
   bugs above — prefer the deep fix even if a JS polyfill would patch
   the symptom.

2. **Vendored deps behind facades** — third-party libs (emnapi, libuv,
   etc.) sit behind project-owned interfaces, imported in exactly one
   adapter file, so they're swappable.

3. **Every shortcut gets BOTH a `#!~debt` inline comment AND a NOTES.md
   catalog entry.**  The 4 new debts in this session follow this rule.

4. **No upstream issue filing** — don't suggest opening issues against
   upstreams (edge.js, emnapi); log deviations in `NOTES.md` instead.

5. **Finish tight and clean** — no task is "done" until typecheck is
   green, dead code is gone, comments match current state, `#!~debt`
   is in sync, and verification ran for real.

6. **Policies DI pattern** — deployment-varying behaviors go through
   `browser-target/src/policies/*.ts`, default is Node-honest, shortcuts
   are opt-in.  When adding ANY behavior that might vary, ask "is this
   a policy?" before hardcoding.

7. **About ESM specifically:** you asked me to investigate `xnitro` in
   `../localwin` BEFORE consulting on edge.js ESM strategy.  Do this
   investigation, then bring findings to YOU for the call.

---

## Investigation toolkit

Useful commands when you come back.

**Run the full test suite:**
```bash
node browser-target/scripts/test-runner.mjs
```

**Run a single test via the harness:**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  --quiet --policies buffer-pool-disable \
  -e "$(cat ../tests/js/log.js)"
```

**Verbose harness run (see [harness] diagnostic lines):**
```bash
cd browser-target && node --experimental-wasm-exnref \
  --import ./node_modules/tsx/dist/loader.mjs scripts/node-harness.mjs \
  -e "..."   # no --quiet
```

**Add a temporary `[compile-debug]` log to see what's being compiled:**
Edit `browser-target/src/napi-host/unofficial.ts`, find
`unofficial_napi_contextify_compile_function`, add at the top:
```ts
ctx.postLog?.(`[compile-debug] ${JSON.stringify(filename)} codeLen=${code.length}`, "debug");
```
Then run without `--quiet` to see the lines.

**Trace tail (last N napi calls before exit):**
Add to `node-harness.mjs` after `_start`:
```js
const tail = trace.tail(50);
for (const r of tail) errlog(`  ${r.t.toFixed(0)}ms ${r.ns}.${r.sym}(...) → ${r.ret}`);
```

**Find all `#!~debt` markers:**
```bash
grep -rn '#!~debt' browser-target/src/ | wc -l   # count
grep -rn '#!~debt' browser-target/src/           # full list
```

**Typecheck:**
```bash
cd browser-target && npx tsc --noEmit
```

**Where the wasm comes from:** `browser-target/edgejs.wasm` — symlink to
the build artifact at `napi/target/.../edgejs.wasm` (gitignored).
Rebuild via the upstream edge build system if you change the wasm-side
contract.

---

*Snapshot taken 2026-05-21 at commit `c369dc61`.  When you resume,
`git log c369dc61..HEAD` will show what's happened since.*
