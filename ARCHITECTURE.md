# Edge.js Architecture

`edge` is a runtime project that aims to replace Node.js while keeping N-API as
the core boundary. Unlike Node internals that integrate directly with V8 in many
paths, `edge` system bindings should be implemented through `napi/v8` APIs.

## Mission

- Build a Node-compatible runtime architecture centered on N-API contracts.
- Keep engine-specific details isolated behind `napi/v8`.
- Implement system/runtime bindings as N-API modules instead of direct V8 code.
- Advance in small, test-validated milestones.

## Porting Policy

- `edge` source and tests should be ported from Node as fully as possible.
- Preserve upstream structure and behavior semantics by default.
- Only exception: any source path using direct V8 APIs should be adapted to use
  N-API APIs instead.
- Prefer compatibility shims and adapter layers over rewriting upstream logic.
- Hard boundary: files under `src` must never include V8 headers
  (`v8.h`, `libplatform/libplatform.h`) or use `v8::` symbols.
- Host/bootstrap code that requires V8 must live outside `src` (for
  example, under `napi/v8`), while `src` remains N-API/Node-API only.

## Non-Goals (for early phases)

- Full Node parity in one step.
- Immediate support for every Node CLI/runtime flag.
- Rewriting all of Node internals at once.

## Core Architecture Direction

- **Runtime kernel**: process/bootstrap/module-loader/event-loop orchestration.
- **Binding layer**: system features exposed as N-API addons (backed by libuv,
  filesystem/network/process primitives).
- **Engine adapter**: `napi/v8` as the only JS engine integration surface.
- **Compatibility layer**: incremental behavior alignment with Node semantics.

## Roadmap Summary

Detailed milestones are tracked in the public roadmap issue:
<https://github.com/wasmerio/edgejs/issues/8>.

1. **Bootstrap**
   - `edge` executable that creates an environment through `napi/v8`.
   - Run/evaluate JS entry scripts.
2. **Minimal runtime primitives**
   - Implement foundational bindings (`process`, timers, console, basic module
     loading) through N-API.
3. **System binding expansion**
   - Add filesystem/path/os/crypto-like primitives as N-API-based modules.
4. **Node-compat iteration**
   - Port behavior test-by-test; close gaps in semantics and errors.
5. **Hardening and scale**
   - Stability, lifecycle, worker/thread integration, performance regression
     tracking.

## Testing Philosophy

Every roadmap step requires:

- Unit tests for new runtime/binding logic.
- Integration tests for end-to-end behavior from JS entrypoint.
- Compatibility tests aligned with Node expectations where feasible.
- A green gate before moving to the next milestone.

No phase should be marked complete without passing its defined test gate.

## WASIX Build

- Use `EDGE_NAPI_PROVIDER=imports` to compile `edge` with N-API imports only
  (no bundled `napi/v8` linkage).
- WASIX toolchain file: `wasix/wasix-toolchain.cmake`.
- Setup + build helper:
  - `wasix/setup-wasix-deps.sh`
  - `wasix/build-wasix.sh`

---

# Browser-Target Architecture

The browser-target (`browser-target/`) is the consumer of `edgejs.wasm`.
It builds a Node-compatible runtime inside the browser worker (or a
Node harness for fast iteration) by composing layered shims around the
wasm module.

## The layered model

```
┌─────────────────────────────────────────────┐
│  L5: User code                              │ ← userScriptPrelude policies
├─────────────────────────────────────────────┤
│  L4: edge.js lib JS (vendored Node lib)     │ ← builtinOverrides policies
├─────────────────────────────────────────────┤
│  L3: napi-host JS (the bridge layer)        │ ← napi-create-function intercepts
├─────────────────────────────────────────────┤
│  L2: emnapi runtime (vendored when patched) │ ← Context/Env JS classes
├─────────────────────────────────────────────┤
│  L1: wasm imports (napi, env, wasi*)        │ ← imports-generated.ts + wasi-shim
├─────────────────────────────────────────────┤
│  L0: edge.js wasm (C++ compiled)            │ ← wasixcc rebuilds
└─────────────────────────────────────────────┘
              ↓ each layer can route work to ↓
        Browser primitives: V8, fetch, Web Streams,
        crypto.subtle, CompressionStream, Workers, OPFS …
```

### What lives where

**L0 (wasm)** — `edgejs.wasm`. Built with `EDGE_NAPI_PROVIDER=imports`
so V8 is NOT linked in. Contains C++ Node lib code, OpenSSL, libuv-wasix,
llhttp, zlib, zstd, cjs-module-lexer, nbytes. ~26MB.

**L1 (wasm imports)** — auto-generated `imports-generated.ts` (186 napi
fns, 80 unofficial_napi_*, 46 wasix, 37 wasi, 8 env) plus hand-written
`wasi-shim.ts` (full sockets/FS/poll). Default-return stubs for unimplemented
ones (returning 0 for napi, ENOSYS for wasi).

**L2 (emnapi)** — `@emnapi/core` and `@emnapi/runtime`. Provides the
napi_env, Context, handle store, and the standard napi function
implementations. Pin: `^1.10.0`. **Vendor locally when patches are
needed** — emnapi's v-table mode (PRs #195/#196) is the future target
for napi_env extensibility.

**L3 (napi-host JS)** — `src/napi-host/`. Patches emnapi for behaviors
edge.js needs but emnapi doesn't provide: wasm-memory-backed buffers,
empty-value property descriptors, microtask/promise-reject intercepts
at `napi_create_function`. ONE adapter file owns each foreign concern.

**L4 (edge.js lib)** — vendored Node lib at `/lib`. Mostly untouched.
Modifications happen via the `builtinOverrides` policy mechanism
(`{ pre, post }` source splicing), not in-place.

**L5 (user code)** — what the user runs via `-e` or as a script. The
active policies' `userScriptPrelude` is prepended before evaluation.

## Design rules

1. **Each layer is independently swappable.** Policies compose
   last-wins; napi-host intercepts compose by name; emnapi is vendored
   so it can be patched.

2. **Lower-layer fixes are more authoritative; higher-layer fixes are
   more flexible.** A fix at L1 affects all consumers; a fix at L4 is
   per-policy. Prefer the highest layer that's still correct.

3. **For every Node feature, prefer the highest-layer offload that's
   correct.** Browser primitive > L4 lib override > L3 napi intercept
   > L1 wasm import > L0 wasm rebuild.

4. **Default behavior is Node-honest.** Throw clearly on unsupported
   APIs (e.g. `outboundThrow` raises `ERR_BROWSER_NO_OUTBOUND` for
   `http.request`). Optimizations and shortcuts are opt-in policies.

5. **Vendored deps sit behind project-owned facades.** Imported in
   exactly one adapter file, so they're swappable. emnapi → `napi-host`
   adapter; vendored Node lib → `builtinOverrides` mechanism.

## Where current concerns live

| Node feature | Layer | How |
|---|---|---|
| JS execution | host V8 | Not in wasm (`imports` mode) — host runs all JS. |
| Microtask queue | host V8 + L1 wasm import | `unofficial_napi_enqueue_microtask` (in `microtask-ops.ts`) routes to host's `queueMicrotask`. |
| Promise rejection | host V8 + L1 wasm import | `unofficial_napi_set_promise_reject_callback` captures lib's handler; `installHostPromiseRejectListeners` forwards host `unhandledrejection` events. |
| Buffer storage | L3 napi patch | Every `Buffer.buffer === wasmMemory.buffer` (SAB), via `buffer-wasm-aliased` policy. |
| TCP / sockets | L1 (`wasi-shim.ts`) | Virtual socket table; sockets route through Service Worker bridge. |
| HTTPS termination | L4 override (`https-as-http`) | Service Worker IS the TLS endpoint; wasm sees pre-parsed HTTP. |
| Outbound HTTP | L4/L5 policy (`outbound-fetch-tunnel`) | `http.request` re-implemented over `globalThis.fetch`. |
| Crypto (hash/HMAC/random) | L0 (bundled OpenSSL) | Candidate for L4 offload via `crypto-via-subtle` policy. |
| Compression (zlib/gzip) | L0 (bundled zlib) | Candidate for L4 offload via `compression-via-compressionstream`. |
| Encoding (TextEncoder/Decoder) | host V8 | Native; lib uses it directly. |
| URL parsing | host V8 (in part) + L0 (full Node URL) | host's URL covers WHATWG; Node's URL has additional APIs in lib. |
| Filesystem | L1 (`fs-adapter.ts`) | Mounts: `/node-lib`, `/node/deps` (read-only sync XHR); userland (in-memory; OPFS pending). |

## Active policies

See `browser-target/src/policies/` for the full list. Each policy is
one file with a `name`, `description`, and any of `builtinOverrides`
(L4) / `userScriptPrelude` (L5) / (planned) `napiOverrides` (L3).

**In `minimalPolicies` (required for correctness)**:
- `bufferPoolDisable` — sets `Buffer.poolSize=0`; required because
  edge's pool slicing doesn't compose with our wasm-backed AB model.
- `bufferWasmAliased` — structural fix making every Buffer's storage
  share memory with wasm (no JS-heap mirror, no sync). Also patches
  AB-prototype primordials to be polymorphic on SAB receivers (needed
  for webstreams/crypto lib code that uses strict V8 getters).

**In `defaultBrowserPolicies` (browser deployments)**:
- All of `minimalPolicies`, plus:
- `inboundHttpsViaSW` — bakes `https → http` so the SW handles TLS.
- `outboundThrow` — Node-honest default: outbound throws clearly.

**Opt-in alternates** (in the registry, not defaults):
- `outboundFetchTunnel` — replaces `outboundThrow` with a fetch-based
  polyfill of `http.request`. For deployments where outbound is needed.
- `bufferWriteSync` — alternative to `bufferWasmAliased` using post-write
  syncs. Diagnostic / fallback. Don't use both at once.
- `taskQueueEnqueueFix` — legacy L4 patch that overrides
  `internalBinding('task_queue').enqueueMicrotask` at the lib level.
  Made redundant by the L1 wasm import (`unofficial_napi_enqueue_microtask`)
  in `microtask-ops.ts`. Kept for diagnostic / fallback use.
- `cryptoHostRandom` — first offload policy.  Routes
  `crypto.randomBytes`, `randomFillSync`, `randomFill`, `randomUUID`
  to the host's native WebCrypto (snapshotted onto
  `globalThis.__edgeHostNativeCrypto` in `host/globals-shim.ts` before
  edge's bootstrap overwrites `globalThis.crypto`).  Smaller surface,
  faster startup, identical Node semantics.  Demonstrates the
  swappable-offload pattern.

## Offload roadmap

Policies queued for implementation, each as a swappable plug-in:

- `crypto-via-subtle` — route `crypto.createHash` / `Hmac` / `pbkdf2` /
  `randomBytes` to `crypto.subtle` and `crypto.getRandomValues`. Should
  shrink the OpenSSL-in-wasm surface by ~80% for typical workloads.
- `compression-via-compressionstream` — route `zlib.createGzip` /
  `createGunzip` / `createDeflate` to `CompressionStream` and
  `DecompressionStream`.
- `streams-via-web-streams` — bridge Node `stream.Readable`/`Writable`
  to `ReadableStream`/`WritableStream` for interop with `fetch`,
  `WebSocket`, `Response.body`, etc.
- `wasm-compile-via-host` — route edge's `WebAssembly.compile` calls to
  the host's native one (fixes the foreground-task-pump deadlock).

## L3 napi-host intercepts

Beyond the policies layer, `src/napi-host/` patches emnapi directly
for behaviors that can't be expressed as module-source overrides:

- **`patchEmnapiToUseWasmBackedBuffers`** — overrides `napi_create_buffer`,
  `napi_create_arraybuffer`, `napi_create_external_arraybuffer`,
  `napi_create_typedarray`, `napi_get_*_info`, `napi_is_arraybuffer`,
  `napi_add_finalizer`. Makes wasm-memory direct-backed Buffers and ABs.
- **`patchEmnapiDefineForEmptyValue`** — rewrites property descriptors
  with all-zero `{method,getter,setter,value}` to use the `undefined`
  handle, so `emnapiDefineProperty` doesn't crash.
- **`installHostPromiseRejectListeners`** (in `microtask-ops.ts`) —
  wires host `process.on('unhandledRejection')` /
  `addEventListener('unhandledrejection')` events to lib's handler
  captured by the L1 wasm import `unofficial_napi_set_promise_reject_callback`.
  Replaces the former `installTaskQueueEnqueueShim` — now superseded
  by the L1 wasm import path for both `enqueueMicrotask` and
  `setPromiseRejectCallback`.
- **`napi_run_script` wrapper** — universal builtin-override hook for
  lazy-required modules (`inspector`, `url`, `crypto`, …). Parses
  `//# sourceURL=node:<id>` and rewrites the source per policy
  `builtinOverrides` before emnapi compiles it.
- **`unofficial_napi_contextify_compile_function`** — same override hook
  for bootstrap-time modules (per_context/*, bootstrap/realm, …).

## Forward direction (when we touch L2 deeper)

emnapi's v-table mode (PR #196 merged 2026-02) introduces:

```c
struct napi_env__ {
  uint64_t sentinel;
  const node_api_js_vtable* js_vtable;     // host-provided function pointers
  const node_api_module_vtable* module_vtable;
};
```

Adopting v-table mode would:
- Move L3 intercepts from "JS-side `napi_create_function` interception"
  to "C++-callable function pointers in a struct" — more authoritative,
  no dead-code-elimination risk.
- Make adding new napi extensions a host-side change (new vtable entry)
  rather than a wasm rebuild.
- Align with Node's upstream Node-API v-table mode (PR #60916).

Adopting v-table mode requires vendoring emnapi (already planned) and
rebuilding `edgejs.wasm` to use the new env layout. Deferred until the
need actually surfaces.

## Iteration loops

**Node harness** (`scripts/node-harness.mjs`): ~3s startup. Same code
paths as browser except `fs.readFileSync` instead of sync XHR. Used
for fast iteration on napi/wasi/crypto/buffer correctness.

**Browser** (`vite dev` on `:5180`): ~15s. Full end-to-end including
Service Worker bridge, OPFS, sync XHR. Used to verify SW-mediated
behaviors.

**Test runner** (`scripts/test-runner.mjs`): iterates `tests/js/*.js`
through the harness with `--quiet`; compares captured stdout/stderr to
sibling `*.stdout` / `*.stderr` files. `*.skip` files mark skips;
`*.harness-args` files add per-test policy/flag overrides.
