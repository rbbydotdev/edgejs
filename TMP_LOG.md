# TMP_LOG — handoff to next session

**Delete this file once you've absorbed it / acted on it.**

## State at handoff

- **Branch**: `main`, 29 commits ahead of `origin/main`. Last commit:
  `6cf92791 rebuild edgejs.wasm with proper napi extension namespace + host-side microtask ops`.
- **Test suite**: 16 pass / 0 fail / 1 skip. Run from `browser-target/`:
  `node scripts/test-runner.mjs`.
- **Local wasm**: `browser-target/edgejs.wasm` (26.5MB, gitignored) is
  the rebuilt artifact with the 83 `unofficial_napi_*` imports under
  the proper `napi_extension_wasmer_v0` namespace.
- **wasixcc**: installed at `~/.wasixcc/bin/`. The build script
  (`wasix/build-wasix.sh`) auto-prepends it to PATH.
- **deps**: `deps/libuv-wasix` and `deps/openssl-wasix` cloned by
  `wasix/setup-wasix-deps.sh`. Untracked (gitignored).

## Where the truth lives — read these in order

1. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the L0-L5 layered model,
   design rules, what lives where, current intercept inventory, and
   active policies. **Read this first.**
2. **[NOTES.md](./NOTES.md)** — current capability matrix, active
   debts, and "Active followups (priority order)" — that section IS
   your queue.
3. **[ARCHIVE.md](./ARCHIVE.md)** — historical bug stories and
   resolved-debt detail. Reach for it when you need to understand WHY
   a fix is shaped the way it is.

## The minimal context probe before you start

```bash
# (cd browser-target)
node scripts/test-runner.mjs          # 16/16 baseline
node --experimental-wasm-exnref -e "
  const m = new WebAssembly.Module(require('fs').readFileSync('edgejs.wasm'));
  const imports = WebAssembly.Module.imports(m);
  console.log('napi_extension_wasmer_v0:', imports.filter(i=>i.module==='napi_extension_wasmer_v0').length);
  console.log('napi:', imports.filter(i=>i.module==='napi').length);
"
# Expected: 83 + 106 = 189 napi imports total
```

If those numbers come back, you've got the rebuilt wasm.

## The immediate followup queue

Priority order — pick from the top:

1. **Verify bugs #2 and #3 are now closed by Phase B.** Both are
   candidates for being root-caused by the broken microtask machinery.
   The reproducers are in NOTES.md. If either is fixed, retire the
   debt entry and write a regression test.

2. **Fresh rebuild to pick up the `#if` removal.**
   `src/edge_task_queue.cc` has the `#if defined(EDGE_BUNDLED_NAPI_V8)`
   gate around `unofficial_napi_set_promise_reject_callback` removed
   (committed but not in the current `browser-target/edgejs.wasm`).
   After rebuild, the L3 `setPromiseRejectCallback` napi_create_function
   intercept in `src/napi-host/index.ts` becomes redundant — the C++
   binding will call our wasm import directly. Drop the intercept then.
   ```bash
   export PATH="$HOME/.wasixcc/bin:$PATH" && ./wasix/build-wasix.sh && cp build-wasix/edgejs.wasm browser-target/edgejs.wasm
   ```
   Rebuild ~5 min from cache (OpenSSL/ICU already compiled).

3. **Drop the L4 `task-queue-enqueue-fix` policy.** Legacy now that
   the wasm import is authoritative. Keep file in the registry one
   more cycle for diagnostic purposes; then delete.

4. **Next offload policy: `compression-via-compressionstream`.**
   Pattern matches `crypto-host-random` exactly — see
   `browser-target/src/policies/crypto-host-random.ts` as the
   reference. Routes `zlib.gzip` / `gunzip` / `deflate` async
   variants through browser `CompressionStream` / `DecompressionStream`.
   Don't touch sync APIs (browser has no sync equivalent).

5. **Vendor emnapi (per the "vendored deps behind facades" rule).**
   Sets up the foundation for adopting emnapi v-table mode (PR #196 in
   upstream). Architecture section "Forward direction (when we touch
   L2 deeper)" in ARCHITECTURE.md describes the target.

## Patterns to follow

- **Adding an offload policy**: model after
  `browser-target/src/policies/crypto-host-random.ts` — uses `{ post }`
  patch on a vendored lib module, captures host primitives at
  `host/globals-shim.ts` if needed (the WebCrypto snapshot pattern).
- **Adding a napi-host extension**: model after
  `browser-target/src/napi-host/microtask-ops.ts` — pure module with
  state + `buildXxxImports(context, state)` that returns import-shape
  functions. Wire into `createNapiHost` in `src/napi-host/index.ts`.
- **Adding a new wasm import namespace**: update `gen-stubs.mjs`
  + `imports-types.ts` + the splitter in `node-harness.mjs`. The
  pattern is established for `napi_extension_wasmer_v0`.

## Subtle gotchas

- **edgejs.wasm is the build artifact, not source.** It's gitignored.
  `git pull` won't update it. Rebuild after touching `src/*.cc`,
  `napi/`, or any other compiled source.
- **`globalThis.crypto` is overridden by edge.js bootstrap.** Native
  WebCrypto is snapshotted onto `globalThis.__edgeHostNativeCrypto` in
  `host/globals-shim.ts` BEFORE edge boots. Policy code wanting host
  crypto must use the snapshot.
- **Buffer storage is wasm-aliased.** Every Buffer's `.buffer === wasmMemory.buffer`
  (a SAB). `crypto.getRandomValues` refuses SAB-backed views in most
  runtimes — copy through a JS-heap intermediate (pattern in
  `crypto-host-random.ts`).
- **Promise rejection wiring is half-baked.** Lib's handler is
  captured but its emission goes through edge's tickCallback which
  our runtime doesn't drive in the same window. See NOTES.md
  "Production gaps (post-microtask-shim)".

## Don't lose these names

- `__edgeHostNativeCrypto` — non-configurable global, snapshot of host WebCrypto
- `__bufDbg` etc. — leftover debug-counter globals from prior sessions (harmless)
- `napi_extension_wasmer_v0` — the import namespace for `unofficial_napi_*`
- `MicrotaskOpsState` — shared host-side state for microtask + promise rejection
- `EDGE_NAPI_PROVIDER=imports` — the build mode that makes V8 a wasm import (vs bundled)
- `wasm-aliased` — every Buffer's storage IS wasm memory (no JS-heap mirror)
