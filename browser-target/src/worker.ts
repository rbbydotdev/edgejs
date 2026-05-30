// Worker entry.  Runs two payloads in sequence:
//   1) hello.wasm — minimal WASI program; smoke-tests the worker + WASI shim.
//   2) edgejs.wasm — the real target; uses emnapi for standard napi_* and our
//      hand-rolled unofficial_napi_* layer + the WASI shim.

import { buildImports } from "./imports-generated";
import { createWasiShim, ExitSignal } from "./wasi-shim";
import { PipeRegistry } from "./wasi-shim/pipes-sab";
import { FsSnapshotRegistry } from "./wasi-shim/fs-snapshot-sab";
import { createBridgeRing, drainBridgeRing } from "./wasi-shim/bridge-sab";
import { syncYieldStrategy } from "./wasi-shim/yield-sync";
import type { YieldStrategy } from "./wasi-shim/yield-strategy";
import { WASIThreads, type WASIInstance } from "./napi-host/emnapi";
import { Trace, toUnifiedJsonl } from "./trace";
import { createNapiHost } from "./napi-host";
import { composePolicies, defaultBrowserPolicies, compressionViaCompressionStream, policyRegistry } from "./policies";
import { defineEdgeEnv, toLegacyShape, asPreset } from "./edge-env";
import { v8Serdes } from "./edge-env/presets/v8-serdes";
import { bufferPoolDisable } from "./edge-env/presets/buffer-pool-disable";
import { taskQueueEnqueueFix } from "./edge-env/presets/task-queue-enqueue-fix";
import { inboundHttpsViaSW } from "./edge-env/presets/inbound-https-via-sw";
import { outboundThrow } from "./edge-env/presets/outbound-throw";
import { outboundFetchTunnel } from "./edge-env/presets/outbound-fetch-tunnel";
import { processExitTerminates } from "./edge-env/presets/process-exit-terminates";
import { processMethodsWasmState } from "./edge-env/presets/process-methods-wasm-state";
import { fastReadFile } from "./edge-env/presets/fast-readfile";
import { wasmCompileViaHost } from "./edge-env/presets/wasm-compile-via-host";
import { bufferWriteSync } from "./edge-env/presets/buffer-write-sync";
import { zlibWriteStateWasm } from "./edge-env/presets/zlib-writestate-wasm";
import { zlibInitParamsWasm } from "./edge-env/presets/zlib-init-params-wasm";
import { compressionViaCompressionStream as compressionViaCompressionStreamPreset } from "./edge-env/presets/compression-via-compressionstream";
import { cryptoHostRandom } from "./edge-env/presets/crypto-host-random";
import { cryptoViaSubtle } from "./edge-env/presets/crypto-via-subtle";
import { cryptoHashViaHostWorker } from "./edge-env/presets/crypto-hash-via-host-worker";
import { cryptoHmacViaHostWorker } from "./edge-env/presets/crypto-hmac-via-host-worker";
import { esmViaBlobImport } from "./edge-env/presets/esm-via-blob-import";
import { esmRequirePreeval } from "./edge-env/presets/esm-require-preeval";
import { esmRequireSucraseBackstop } from "./edge-env/presets/esm-require-sucrase-backstop";
import { bufferWasmAliased } from "./edge-env/presets/buffer-wasm-aliased";
import { childProcessViaExecutor } from "./edge-env/presets/child-process-via-executor";
import { workerThreadsPerThread } from "./edge-env/presets/worker-threads-per-thread";
import { bufferBase64 } from "./edge-env/presets/buffer-base64";
import { bufferCopy } from "./edge-env/presets/buffer-copy";
import { vmSameRealm } from "./edge-env/presets/vm-same-realm";
import { pollWakeOnSchedule } from "./edge-env/presets/poll-wake-on-schedule";
import { utilGetOwnNonIndexProperties } from "./edge-env/presets/util-get-own-non-index-properties";
import { utilTypesAsyncGen } from "./edge-env/presets/util-types-async-gen";
import { utilGetProxyDetails } from "./edge-env/presets/util-get-proxy-details";
import { utilGetConstructorName } from "./edge-env/presets/util-get-constructor-name";
import { osPriorityStateful } from "./edge-env/presets/os-priority-stateful";
import { stringDecoderJs } from "./edge-env/presets/string-decoder-js";
import { decodeBase64 } from "./edge-env/vendor-adapters/unenv-base64";
import { createBundledFs } from "./host/fs/adapters/bundled";
// opfs + layered adapters now live on the bridge worker.  Runtime
// worker has only a minimal bundled-fs for any wasi-shim paths that
// don't go through the SAB snapshot (legacy / debug paths).
import { DEFAULT_MEM_OPTIONS, instrumentNamespace, pendingMem } from "./mem-snapshot";
import { runSabViewAliasingDiagnostic, formatReport as formatSabReport } from "./diagnostics/sab-view-aliasing";
import { createByteLengthWatcher, formatEvents as formatBlEvents } from "./diagnostics/byteLength-watcher";

declare const self: DedicatedWorkerGlobalScope;

// Edge's bootstrap mutates globalThis (it expects to own the global env).
// Capture native APIs we need *before* we hand control to the wasm so edge
// can't shadow them mid-run.
const nowMs = performance.now.bind(performance);
// Native MessageChannel ctor used by the cp.send sendHandle bridge in
// internal-post-patch.runtime.js: when user code passes an edge.js
// MessagePort, we wrap it with a native channel pair so the *native*
// port can be transferred across the structured-clone wire (edge's
// MessagePort instances aren't recognized as transferable).
const NativeMessageChannel = MessageChannel;
(globalThis as { __edgeNativeMessageChannel?: typeof MessageChannel })
  .__edgeNativeMessageChannel = NativeMessageChannel;
// Native URL + Blob ctors used by the ESM blob trampoline
// (napi-host/esm-registry.ts).  Edge swaps `URL` for its own
// implementation during bootstrap (lib/internal/url.js), which produces
// `blob:nodedata:` URLs that the browser can't fetch in `import()`.
// Cache the host's native ctors at module load so our blob-URL
// synthesis goes through the browser's real URL.createObjectURL.
const NativeURL = URL;
const NativeBlob = Blob;
(globalThis as {
  __edgeNativeURL?: typeof URL;
  __edgeNativeBlob?: typeof Blob;
}).__edgeNativeURL = NativeURL;
(globalThis as { __edgeNativeBlob?: typeof Blob }).__edgeNativeBlob = NativeBlob;
// Sucrase ESM-to-CJS transform exposed for two consumers:
//
//   1. `napi-host/esm-registry.ts:detectTopLevelAwait` — calls the
//      transform on every `create_source_text`, ignoring the output;
//      it relies on `new Function(transformedCode)` throwing
//      SyntaxError when the source had top-level await (which
//      Sucrase preserves as-is; CJS Function bodies can't contain
//      await outside async context).
//
//   2. `policies/esm-require-sucrase-backstop` (opt-in) — calls
//      the transform when lib's `ModuleJobSync.runSync` throws
//      `ERR_REQUIRE_ASYNC_MODULE`, evals the CJS-shaped result in
//      a constructed context to back-fill the namespace.
//
// Eager import (Sucrase is pure JS, sub-ms init).  When `filePath`
// is provided, the transform emits a source map and appends a
// `//# sourceMappingURL=data:...` comment so V8 maps runtime stack
// traces from the eval'd code back to the original .mjs source.
// Consumer #1 ignores the appended comment; consumer #2 benefits
// from accurate debugger line numbers on errors thrown by user
// ESM code that hit the backstop.
import { transform as sucraseTransform } from "sucrase";
(globalThis as {
  __edgeEsmSucraseTransform?: (src: string, opts?: { filePath?: string }) => string;
}).__edgeEsmSucraseTransform = (src: string, opts?: { filePath?: string }) => {
  const filePath = opts?.filePath;
  const result = sucraseTransform(src, {
    transforms: ["imports"],
    filePath,
    sourceMapOptions: filePath ? { compiledFilename: filePath } : undefined,
  });
  let code = result.code;
  if (result.sourceMap) {
    const json = JSON.stringify(result.sourceMap);
    code += "\n//# sourceMappingURL=data:application/json;charset=utf-8," +
            encodeURIComponent(json) + "\n";
  }
  return code;
};

// Reverse-RPC dispatcher.  Wraps the user-facing dispatch callback in
// `setImmediate` so it runs OUTSIDE the reverse-RPC handler's try/catch
// — `process.exit` thrown from the user's event handler then propagates
// through `_start`'s normal exit-signal path instead of being swallowed
// as a generic error.  Resolves worker-threads-reverse-rpc-exit-fragility
// for every reverse-RPC delivery channel (exit, message-to-child,
// message-from-child).
//
// The libuv-pending-handle status for worker-threads message channels
// comes from `uv_async_t` slots managed by
// `policies/worker-threads-per-thread.ts`.  Real Path A: when a
// reverse-RPC delivery is queued the corresponding slot is also poked
// via `pokeWorkerSlot` / `pokeParentPortSlot` — `uv_async_send` fires
// `uv__async_io` which writes the wake-pipe wfd, `poll_oneoff` returns
// immediately, and the next `uv_run` iteration runs the queued
// `setImmediate` callback.  `OP_DELIVER_USER_WORKER_EXIT` doesn't share
// that wake path — exit delivery happens after the child's libuv loop
// has already drained.
//
// Wake-up helpers.  The worker-threads-per-thread policy publishes
// per-Worker `UvAsyncSlot` instances on `globalThis.__edgeUvAsyncSlots`
// (parent side, Map<workerId, slot>) and a single
// `globalThis.__edgeParentPortUvAsyncSlot` on the child side.  Both
// helpers swallow errors: if the slot was closed or torn down
// mid-flight (Worker exit, `removeAllListeners`) the dispatcher's
// `setImmediate` still fires; the policy's `setInterval` fallback
// covers any deployment where `uvAsync` wasn't available at keepalive
// setup time.  See `policies/worker-threads-per-thread.ts` for the
// slot lifecycle.
type UvAsyncSlotLike = { send(): void };
function pokeWorkerSlot(workerId: number): void {
  const slots = (globalThis as { __edgeUvAsyncSlots?: Map<number, UvAsyncSlotLike> })
    .__edgeUvAsyncSlots;
  if (!slots) return;
  const slot = slots.get(workerId);
  if (!slot) return;
  try { slot.send(); }
  catch (e) { void e; /* slot may have been closed; setImmediate path still drains */ }
}
function pokeParentPortSlot(): void {
  const slot = (globalThis as { __edgeParentPortUvAsyncSlot?: UvAsyncSlotLike | null })
    .__edgeParentPortUvAsyncSlot;
  if (!slot) return;
  try { slot.send(); }
  catch (e) { void e; }
}

function dispatchOnLibuvTick(label: string, fn: () => void): void {
  setImmediate(() => {
    try { fn(); }
    catch (err) {
      post("log", { text: `[runtime] ${label} dispatch threw: ${(err as Error).message}`, level: "warn" });
    }
  });
}

function post(kind: string, payload: Record<string, unknown> = {}) {
  self.postMessage({ kind, ...payload });
}

// FS snapshot SAB is sent to us by main.ts BEFORE the "start" message
// (main.ts spawns bridge worker first, waits for its `bridge-ready`,
// then spawns us and immediately hands us the SAB).  Bridge worker
// keeps draining the snapshot's request ring while our wasm runs —
// this is the core of the runtime-on-separate-worker split.
let fsSnapshotSab: SharedArrayBuffer | null = null;

// L2 host worker RPC plumbing.  main.ts spawns the host worker
// alongside us and hands us its request+reply SAB rings via an
// "edge-host-rpc-sab" message before boot.  We attach an RpcClient
// once both SABs arrive — used today only for the L2 ping smoke test;
// L3+ wires this into napi-host.
import { attachRing as attachHostRing } from "./wasi-shim/sab-ring";
import { RpcClient } from "./host-worker/rpc-client";
import { RpcServer } from "./host-worker/rpc-server";
import { SyncRpcClient } from "./host-worker/rpc-client-sync";
import { OP_PING, OP_WASM_ECHO, OP_SUBTLE_DIGEST, OP_SUBTLE_HMAC, OP_SUBTLE_DIGEST_VIA_NAPI_MEM, OP_SUBTLE_HMAC_VIA_NAPI_MEM, OP_NAPI_OPEN_HANDLE_SCOPE, OP_NAPI_CLOSE_HANDLE_SCOPE, OP_SPAWN_USER_WORKER, OP_DELIVER_USER_WORKER_EXIT, OP_WORKER_POST_MESSAGE_TO_CHILD, OP_WORKER_POST_MESSAGE_TO_PARENT, OP_DELIVER_MESSAGE_TO_CHILD, OP_DELIVER_MESSAGE_FROM_CHILD, OP_RUN_CHILD_PROCESS, OP_SPAWN_ASYNC_START, OP_SPAWN_ASYNC_KILL, OP_SPAWN_ASYNC_EVENT, OP_SPAWN_STDIO_WRITE, OP_SPAWN_STDIO_END, OP_SPAWN_IPC_SEND, OP_SPAWN_IPC_DISCONNECT, DIGEST_STAGING_OFFSET, REPLY_STATUS_OK, REPLY_STATUS_INVALID_ARGS, REPLY_STATUS_HOST_ERROR, HOST_RPC_RING_CONFIG } from "./host-worker/rpc-protocol";
import { packPostMessage, unpackPostMessage } from "./host-worker/marshal-postmessage";
import { registerWasmCallbackInvoker, createCallbackDepthCounter } from "./host-worker/callback-dispatch";
import { attachIpcStructuredPort as attachStructuredPort } from "./host-worker/ipc-structured-port";
let hostRpcClient: RpcClient | null = null;
/** E18: sync variant on the forward channel (wasm → host).  Wraps the
 *  same request/reply SAB pair that `hostRpcClient` uses, but blocks
 *  the wasm thread via Atomics.wait until a reply arrives — needed by
 *  policies that must offload a Node SYNC API (e.g. `Hash.digest()`)
 *  to a host async API.  Async-by-default APIs (pbkdf2 callback,
 *  WebAssembly.compile) continue to use the async `hostRpcClient`. */
let hostRpcSyncClient: SyncRpcClient | null = null;
/** Reverse-channel server: host can request things FROM wasm worker.
 *  Used for finalizers, threadsafe function dispatch in L5+. */
let reverseRpcServer: RpcServer | null = null;
let hostWorkerId = -1;
/** F-2: SAB view of the host's napi memory.  Lets wasm runtime worker
 *  read what host emnapi wrote (and vice versa).  Same buffer, shared
 *  across worker boundary. */
let hostNapiMemoryView: Uint32Array | null = null;
/** E22: byte-level view of the host's napi memory SAB, used by the
 *  `__edgeHostDigestSync` global to copy large input data into the
 *  digest staging region.  Same SAB as `hostNapiMemoryView`, different
 *  element width. */
let hostNapiMemoryBytes: Uint8Array | null = null;
function getHostNapiMemoryView(): Uint32Array | null { return hostNapiMemoryView; }
// Re-exported indirectly via a global accessor so other modules can use it.
(globalThis as { __edgeHostNapiMemView?: () => Uint32Array | null }).__edgeHostNapiMemView = getHostNapiMemoryView;

/** F-9 path-a: single-shared-wake view.  The host bumps this counter on
 *  every forward-reply publish AND reverse-request publish; a wasm-side
 *  `SyncRpcClient` constructed with `sharedWake` blocks on it so a
 *  reverse request arriving during a forward-blocked sync RPC reliably
 *  wakes the wait loop.  See experiments/r6-nested-sync-rpc/FINDINGS.md.
 *  Stored as `{ i32, idx }` to mirror the `SharedWakeView` shape the
 *  RPC clients accept. */
let sharedWake: { i32: Int32Array; idx: number } | null = null;
function getSharedWake(): { i32: Int32Array; idx: number } | null { return sharedWake; }
(globalThis as { __edgeHostSharedWake?: () => { i32: Int32Array; idx: number } | null }).__edgeHostSharedWake = getSharedWake;

/** E18 / E22: synchronous digest bridge.  The `crypto-hash-via-host-worker`
 *  policy patches `lib/crypto.js`'s `createHash().digest()` to call
 *  `globalThis.__edgeHostDigestSync(algo, bytes)` and return the raw
 *  digest bytes.  Implementation here parks the wasm thread via
 *  `Atomics.wait` until the host worker replies with the digest
 *  computed by `SubtleCrypto.digest(...)`.
 *
 *  TRANSPORT SELECTION (E22)
 *
 *  - Small inputs (≤ SLOT_PAYLOAD_BUDGET ~4 KiB): use OP_SUBTLE_DIGEST
 *    and frame `(algoName, dataLen, dataBytes)` into the RPC slot.
 *    Fewest hops, no shared-memory dependency.
 *  - Larger inputs: copy the bytes into the digest staging region of
 *    the shared napi-host-memory SAB at DIGEST_STAGING_OFFSET, then
 *    send OP_SUBTLE_DIGEST_VIA_NAPI_MEM whose payload is just
 *    `(algoName, dataOffset, dataLen)` (<100 B).  Bypasses the
 *    single-slot framing cap.  The wasm thread blocks on Atomics.wait
 *    while the host reads the staging region, so the offset is reused
 *    across calls without contention. */
function installHostDigestSyncGlobal(): void {
  const TE = new TextEncoder();
  type HostDigestSync = (algoName: string, bytes: Uint8Array) => Uint8Array;
  // Slot payload capacity = HOST_RPC_RING_CONFIG.slotSize - SLOT_HEADER_SIZE
  // (16) - REQUEST_HEADER_SIZE (8) = 4096 - 16 - 8 = 4072 bytes total.
  // Subtract the wire framing overhead (algo_len u32 + algo bytes +
  // data_len u32) to get the available data budget for the small-input
  // OP_SUBTLE_DIGEST path.
  const SLOT_PAYLOAD_BUDGET = HOST_RPC_RING_CONFIG.slotSize - 16 - 8;
  const impl: HostDigestSync = (algoName: string, bytes: Uint8Array) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgeHostDigestSync: host RPC sync client not attached");
    }
    const algoBytes = TE.encode(algoName);
    const algoLen = algoBytes.byteLength;
    const dataLen = bytes.byteLength;
    const framedLen = 4 + algoLen + 4 + dataLen;

    // Small-input fast path: frame everything into one slot.
    if (framedLen <= SLOT_PAYLOAD_BUDGET) {
      const payload = new Uint8Array(framedLen);
      const dv = new DataView(payload.buffer);
      dv.setUint32(0, algoLen, true);
      payload.set(algoBytes, 4);
      dv.setUint32(4 + algoLen, dataLen, true);
      if (dataLen > 0) payload.set(bytes, 4 + algoLen + 4);
      const reply = hostRpcSyncClient.callSync(OP_SUBTLE_DIGEST, hostWorkerId, 0, payload);
      if (reply.status !== REPLY_STATUS_OK) {
        const msg = new TextDecoder().decode(reply.payload) || `OP_SUBTLE_DIGEST status=${reply.status}`;
        throw new Error("__edgeHostDigestSync: " + msg);
      }
      return reply.payload;
    }

    // E22 large-input path: stage data in the shared napi memory SAB.
    if (!hostNapiMemoryBytes) {
      throw new Error(
        "__edgeHostDigestSync: napi memory SAB not attached; large-input path unavailable. " +
        "(Small-input fast path remains usable.)",
      );
    }
    const napiMemLen = hostNapiMemoryBytes.byteLength;
    const stagingCapacity = napiMemLen - DIGEST_STAGING_OFFSET;
    if (dataLen > stagingCapacity) {
      // The staging region is bounded by the napi memory size minus the
      // bump-allocator reserve.  At 4-page initial = 256 KiB, that's
      // ~128 KiB.  Growing the napi memory would extend this; for now
      // surface a clear error so callers can drop the policy for huge
      // inputs.
      throw new Error(
        `__edgeHostDigestSync: data too large for digest staging region ` +
        `(${dataLen}B > capacity ${stagingCapacity}B at offset ${DIGEST_STAGING_OFFSET}). ` +
        `Disable crypto-hash-via-host-worker policy for inputs >${stagingCapacity}B.`,
      );
    }
    // Copy input bytes into staging.  Single-flight: this sync RPC
    // blocks the wasm thread until the host reply lands, so there is
    // no concurrent use of the staging region from this worker.
    if (dataLen > 0) {
      hostNapiMemoryBytes.set(bytes, DIGEST_STAGING_OFFSET);
    }
    // Build the small request payload: algo_name + (offset, len) triple.
    const reqLen = 4 + algoLen + 4 + 4;
    const payload = new Uint8Array(reqLen);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, algoLen, true);
    payload.set(algoBytes, 4);
    dv.setUint32(4 + algoLen, DIGEST_STAGING_OFFSET, true);
    dv.setUint32(4 + algoLen + 4, dataLen, true);
    const reply = hostRpcSyncClient.callSync(
      OP_SUBTLE_DIGEST_VIA_NAPI_MEM, hostWorkerId, 0, payload,
    );
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = new TextDecoder().decode(reply.payload) || `OP_SUBTLE_DIGEST_VIA_NAPI_MEM status=${reply.status}`;
      throw new Error("__edgeHostDigestSync: " + msg);
    }
    return reply.payload;
  };
  (globalThis as { __edgeHostDigestSync?: HostDigestSync }).__edgeHostDigestSync = impl;
}

/** E21 / E22-C: synchronous HMAC bridge.  The `crypto-hmac-via-host-worker`
 *  policy patches `lib/crypto.js`'s `createHmac().digest()` to call
 *  `globalThis.__edgeHostHmacSync(algo, key, bytes)` and return the
 *  raw MAC bytes.  Same Atomics.wait shape as
 *  `installHostDigestSyncGlobal`; wire format extends with a
 *  key-bytes preamble.
 *
 *  TRANSPORT SELECTION (E22-C, mirrors digest)
 *
 *  - Small inputs (key + data + algo fits the ~4 KiB slot): use
 *    OP_SUBTLE_HMAC and frame everything inline.  Same as E21.
 *  - Larger combined inputs: stage key followed by data in the shared
 *    napi-host-memory SAB (sharing the digest staging region — both
 *    ops are single-flight via sync RPC, so no overlap).  Send
 *    OP_SUBTLE_HMAC_VIA_NAPI_MEM whose payload is just
 *    `(algoName, keyOffset, keyLen, dataOffset, dataLen)` (<100 B). */
function installHostHmacSyncGlobal(): void {
  const TE = new TextEncoder();
  type HostHmacSync = (algoName: string, key: Uint8Array, bytes: Uint8Array) => Uint8Array;
  const SLOT_PAYLOAD_BUDGET = HOST_RPC_RING_CONFIG.slotSize - 16 - 8;
  const impl: HostHmacSync = (algoName: string, key: Uint8Array, bytes: Uint8Array) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgeHostHmacSync: host RPC sync client not attached");
    }
    const algoBytes = TE.encode(algoName);
    const algoLen = algoBytes.byteLength;
    const keyLen = key.byteLength;
    const dataLen = bytes.byteLength;
    const framedLen = 4 + algoLen + 4 + keyLen + 4 + dataLen;

    // Small-input fast path: frame everything into one slot.
    if (framedLen <= SLOT_PAYLOAD_BUDGET) {
      const payload = new Uint8Array(framedLen);
      const dv = new DataView(payload.buffer);
      dv.setUint32(0, algoLen, true);
      payload.set(algoBytes, 4);
      dv.setUint32(4 + algoLen, keyLen, true);
      if (keyLen > 0) payload.set(key, 4 + algoLen + 4);
      dv.setUint32(4 + algoLen + 4 + keyLen, dataLen, true);
      if (dataLen > 0) payload.set(bytes, 4 + algoLen + 4 + keyLen + 4);
      const reply = hostRpcSyncClient.callSync(OP_SUBTLE_HMAC, hostWorkerId, 0, payload);
      if (reply.status !== REPLY_STATUS_OK) {
        const msg = new TextDecoder().decode(reply.payload) || `OP_SUBTLE_HMAC status=${reply.status}`;
        throw new Error("__edgeHostHmacSync: " + msg);
      }
      return reply.payload;
    }

    // E22-C large-input path: stage key + data in the shared napi memory SAB.
    if (!hostNapiMemoryBytes) {
      throw new Error(
        "__edgeHostHmacSync: napi memory SAB not attached; large-input path unavailable. " +
        "(Small-input fast path remains usable.)",
      );
    }
    // Lay out key, then data 8-byte aligned, both inside the staging
    // region (which is shared with digest; sync RPC single-flight makes
    // it safe).  Total occupied = alignedKeyLen + dataLen.
    const KEY_OFFSET = DIGEST_STAGING_OFFSET;
    const alignedKeyLen = (keyLen + 7) & ~7;
    const DATA_OFFSET = KEY_OFFSET + alignedKeyLen;
    const napiMemLen = hostNapiMemoryBytes.byteLength;
    const stagingCapacity = napiMemLen - DIGEST_STAGING_OFFSET;
    const totalNeeded = alignedKeyLen + dataLen;
    if (totalNeeded > stagingCapacity) {
      throw new Error(
        `__edgeHostHmacSync: key+data too large for staging region ` +
        `(key=${keyLen}B aligned=${alignedKeyLen}B + data=${dataLen}B = ${totalNeeded}B ` +
        `> capacity ${stagingCapacity}B at offset ${DIGEST_STAGING_OFFSET}). ` +
        `Disable crypto-hmac-via-host-worker policy for combined inputs >${stagingCapacity}B.`,
      );
    }
    // Copy key+data into staging.  Single-flight: this sync RPC blocks
    // the wasm thread until host reply lands; no concurrent use.
    if (keyLen > 0) hostNapiMemoryBytes.set(key, KEY_OFFSET);
    if (dataLen > 0) hostNapiMemoryBytes.set(bytes, DATA_OFFSET);
    // Build the small request payload: algo + (key_off, key_len, data_off, data_len).
    const reqLen = 4 + algoLen + 4 + 4 + 4 + 4;
    const payload = new Uint8Array(reqLen);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, algoLen, true);
    payload.set(algoBytes, 4);
    dv.setUint32(4 + algoLen, KEY_OFFSET, true);
    dv.setUint32(4 + algoLen + 4, keyLen, true);
    dv.setUint32(4 + algoLen + 8, DATA_OFFSET, true);
    dv.setUint32(4 + algoLen + 12, dataLen, true);
    const reply = hostRpcSyncClient.callSync(
      OP_SUBTLE_HMAC_VIA_NAPI_MEM, hostWorkerId, 0, payload,
    );
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = new TextDecoder().decode(reply.payload) || `OP_SUBTLE_HMAC_VIA_NAPI_MEM status=${reply.status}`;
      throw new Error("__edgeHostHmacSync: " + msg);
    }
    return reply.payload;
  };
  (globalThis as { __edgeHostHmacSync?: HostHmacSync }).__edgeHostHmacSync = impl;
}

// ── Worker-threads phase 1: spawn-node-worker globalThis (Path B) ───
//
// See docs/worker-threads-design.md "How the lib patch reaches the host".
// Lib's patched `internal/worker.js` calls this function synchronously
// when user code does `new Worker(filename)`.  We park the wasm thread
// on Atomics.wait via the sync RPC client; the host worker forwards to
// main, main spawns the (host+wasm) pair, returns the workerId.
//
// Why Path B (this function) instead of Path A (a wasm primitive): see
// the design doc.  Short version: matches the established E18/E21/E22
// offload pattern; no C++ scaffolding per primitive.

// `bootstrapScript` is a JS source string evaluated verbatim in the
// child wasm runtime's user-script slot AFTER edge.js boots.  The
// policy patch (worker-threads-per-thread.ts) is responsible for
// constructing the right script: `require(<resolved-path>)` for file
// mode, or the user's code as-is for eval mode.  Direct callers (e.g.
// the phase-1 spawn-exit probe test) can pass any JS.
type SpawnNodeWorker = (bootstrapScript: string, workerData?: Uint8Array) => number;

function installSpawnNodeWorkerGlobal(): void {
  const impl: SpawnNodeWorker = (bootstrapScript, workerData) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgeSpawnNodeWorker: host RPC sync client not attached");
    }
    const bsBytes = new TextEncoder().encode(bootstrapScript);
    const wd = workerData ?? new Uint8Array(0);
    const payload = new Uint8Array(4 + bsBytes.byteLength + 4 + wd.byteLength);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, bsBytes.byteLength, true);
    payload.set(bsBytes, 4);
    dv.setUint32(4 + bsBytes.byteLength, wd.byteLength, true);
    payload.set(wd, 4 + bsBytes.byteLength + 4);
    const reply = hostRpcSyncClient.callSync(OP_SPAWN_USER_WORKER, hostWorkerId, 0, payload);
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = new TextDecoder().decode(reply.payload) || `spawn-user-worker status=${reply.status}`;
      throw new Error("__edgeSpawnNodeWorker: " + msg);
    }
    if (reply.payload.byteLength < 4) {
      throw new Error("__edgeSpawnNodeWorker: reply payload too short");
    }
    return new DataView(
      reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength,
    ).getUint32(0, true);
  };
  (globalThis as { __edgeSpawnNodeWorker?: SpawnNodeWorker }).__edgeSpawnNodeWorker = impl;
}

// child-process-via-executor (async path) global. Sync RPC to the host
// worker, which runs the user-installed executor (sync OR async) in its
// own event loop and returns the binary frame back. Wasm thread blocks
// on Atomics.wait the whole time -- no JSPI involvement.
//
// Payload format: see child-process-via-executor.ts (packRequest /
// unpackReply). Binary, not JSON-encoded numbers -- ~6x more efficient.
type SpawnChildProcessSync = (request: Uint8Array) => Uint8Array;

function installSpawnChildProcessGlobal(): void {
  const impl: SpawnChildProcessSync = (request) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgeChildProcessSpawnSync: host RPC sync client not attached");
    }
    const reply = hostRpcSyncClient.callSync(OP_RUN_CHILD_PROCESS, hostWorkerId, 0, request);
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = new TextDecoder().decode(reply.payload) || `run-child-process status=${reply.status}`;
      throw new Error("__edgeChildProcessSpawnSync: " + msg);
    }
    // Copy out -- the reply aliases the SAB slot which gets reused.
    const out = new Uint8Array(reply.payload.byteLength);
    out.set(reply.payload);
    return out;
  };
  (globalThis as { __edgeChildProcessSpawnSync?: SpawnChildProcessSync }).__edgeChildProcessSpawnSync = impl;
}

// Async child_process globals: spawn() / exec() / execFile() paths.
//
// __edgeChildProcessSpawnAsync(requestBytes) -> { childId, status }
//   Sync RPC to host -> START -> returns immediately. Events stream
//   back via reverse-RPC (registered separately below).
//
// __edgeChildProcessKillAsync(childId, signalName) -> ok
//   Sync RPC to host -> KILL -> AbortController fires on host;
//   executor cooperates (or events drain naturally).
type SpawnAsyncStart = (request: Uint8Array) => { childId: number; status: number };
type KillAsync = (childId: number, signalName: string) => boolean;
type StdinWrite = (childId: number, chunk: Uint8Array) => number;
type StdinEnd = (childId: number) => number;

function installSpawnChildProcessAsyncGlobals(): void {
  const start: SpawnAsyncStart = (request) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgeChildProcessSpawnAsync: host RPC sync client not attached");
    }
    const reply = hostRpcSyncClient.callSync(OP_SPAWN_ASYNC_START, hostWorkerId, 0, request);
    if (reply.status !== REPLY_STATUS_OK || reply.payload.byteLength < 8) {
      return { childId: 0, status: -1 };
    }
    const dv = new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength);
    return { childId: dv.getUint32(0, true), status: dv.getInt32(4, true) };
  };
  const kill: KillAsync = (childId, signalName) => {
    if (!hostRpcSyncClient) return false;
    const sigBytes = new TextEncoder().encode(signalName || "SIGTERM");
    const req = new Uint8Array(4 + 4 + sigBytes.byteLength);
    const dv = new DataView(req.buffer);
    dv.setUint32(0, childId, true);
    dv.setUint32(4, sigBytes.byteLength, true);
    req.set(sigBytes, 8);
    const reply = hostRpcSyncClient.callSync(OP_SPAWN_ASYNC_KILL, hostWorkerId, 0, req);
    if (reply.status !== REPLY_STATUS_OK || reply.payload.byteLength < 4) return false;
    return new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength).getUint32(0, true) === 0;
  };
  // P3.2 + P3.5 stdio pipe: write/end ops forwarded sync to host. Wasm
  // thread blocks for the duration of the RPC -- typically microseconds
  // (host just queues into a per-child array). Sync semantics mirror
  // Node: the OS write() returns after the kernel takes the bytes;
  // here the "kernel" is the host worker's queue.
  // fdIndex parameter: 0 for stdin (legacy stdinWrite alias), N>=3 for
  // extra stdio[N] pipes (P3.5 multi-stdio).
  type StdioWrite = (childId: number, fdIndex: number, chunk: Uint8Array) => number;
  type StdioEnd = (childId: number, fdIndex: number) => number;
  const stdioWrite: StdioWrite = (childId, fdIndex, chunk) => {
    if (!hostRpcSyncClient) return 1;
    const req = new Uint8Array(8 + chunk.byteLength);
    const dv = new DataView(req.buffer);
    dv.setUint32(0, childId, true);
    dv.setUint32(4, fdIndex, true);
    if (chunk.byteLength > 0) req.set(chunk, 8);
    const reply = hostRpcSyncClient.callSync(OP_SPAWN_STDIO_WRITE, hostWorkerId, 0, req);
    if (reply.status !== REPLY_STATUS_OK || reply.payload.byteLength < 4) return 1;
    return new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength).getUint32(0, true);
  };
  const stdioEnd: StdioEnd = (childId, fdIndex) => {
    if (!hostRpcSyncClient) return 1;
    const req = new Uint8Array(8);
    const dv = new DataView(req.buffer);
    dv.setUint32(0, childId, true);
    dv.setUint32(4, fdIndex, true);
    const reply = hostRpcSyncClient.callSync(OP_SPAWN_STDIO_END, hostWorkerId, 0, req);
    if (reply.status !== REPLY_STATUS_OK || reply.payload.byteLength < 4) return 1;
    return new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength).getUint32(0, true);
  };
  // Legacy aliases (fd-0 hardcoded) -- old policy code still calls
  // these. P3.5's new bindings use stdioWrite/End directly with explicit
  // fd index.
  const stdinWrite: StdinWrite = (childId, chunk) => stdioWrite(childId, 0, chunk);
  const stdinEnd: StdinEnd = (childId) => stdioEnd(childId, 0);
  // P3.3 IPC: wasm-side child.send(json) and child.disconnect() forward
  // through these sync RPC ops. Same micro-latency cost as stdin
  // write/end -- host just queues + dispatches to executor handlers.
  type IpcSend = (childId: number, json: string) => number;
  type IpcDisconnect = (childId: number) => number;
  const ipcSend: IpcSend = (childId, json) => {
    if (!hostRpcSyncClient) return 1;
    const bytes = new TextEncoder().encode(json);
    const req = new Uint8Array(8 + bytes.byteLength);
    const dv = new DataView(req.buffer);
    dv.setUint32(0, childId, true);
    dv.setUint32(4, bytes.byteLength, true);
    if (bytes.byteLength > 0) req.set(bytes, 8);
    const reply = hostRpcSyncClient.callSync(OP_SPAWN_IPC_SEND, hostWorkerId, 0, req);
    if (reply.status !== REPLY_STATUS_OK || reply.payload.byteLength < 4) return 1;
    return new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength).getUint32(0, true);
  };
  const ipcDisconnect: IpcDisconnect = (childId) => {
    if (!hostRpcSyncClient) return 1;
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, childId, true);
    const reply = hostRpcSyncClient.callSync(OP_SPAWN_IPC_DISCONNECT, hostWorkerId, 0, req);
    if (reply.status !== REPLY_STATUS_OK || reply.payload.byteLength < 4) return 1;
    return new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength).getUint32(0, true);
  };
  (globalThis as { __edgeChildProcessSpawnAsync?: SpawnAsyncStart }).__edgeChildProcessSpawnAsync = start;
  (globalThis as { __edgeChildProcessKillAsync?: KillAsync }).__edgeChildProcessKillAsync = kill;
  (globalThis as { __edgeChildProcessStdinWrite?: StdinWrite }).__edgeChildProcessStdinWrite = stdinWrite;
  (globalThis as { __edgeChildProcessStdinEnd?: StdinEnd }).__edgeChildProcessStdinEnd = stdinEnd;
  (globalThis as { __edgeChildProcessStdioWrite?: StdioWrite }).__edgeChildProcessStdioWrite = stdioWrite;
  (globalThis as { __edgeChildProcessStdioEnd?: StdioEnd }).__edgeChildProcessStdioEnd = stdioEnd;
  (globalThis as { __edgeChildProcessIpcSend?: IpcSend }).__edgeChildProcessIpcSend = ipcSend;
  (globalThis as { __edgeChildProcessIpcDisconnect?: IpcDisconnect }).__edgeChildProcessIpcDisconnect = ipcDisconnect;
}

// Worker-threads phase 2: postMessage globals.  Pure plumbing — they
// shuttle marshaled bytes through sync forward RPC (wasm → host → main
// → other host → reverse RPC → wasm).  The actual JS-value
// pack/unpack is done by the policy patch (worker-threads-per-thread)
// which calls these AFTER marshaling, so we keep these globals tiny
// and bytes-only.
//
// SPOOF-PROOF CONTROL ENVELOPE (e34+): byte 0 of the transported
// payload is a "kind" tag that worker.ts owns end-to-end.  User data
// always goes out as KIND_USER_DATA=0x00, so a user payload containing
// fields like `__edgeWorkerTerminate: true` can NEVER reach the
// control path — the dispatcher gates on byte 0, not on the
// unmarshaled object.  Control senders use a distinct kind value:
//
//   0x00  KIND_USER_DATA      [marshaled user value bytes]
//   0x01  KIND_PORT_MSG       [u32 targetPortId LE][marshaled payload]
//   0x02  KIND_TERMINATE      (empty)
//   0x03  KIND_WORKER_ERROR   [marshaled error info]
//
// Receiver branches on byte 0 BEFORE handing payload to the policy
// dispatcher, which keeps the marshal layer purely about user data.
const KIND_USER_DATA = 0x00;
const KIND_PORT_MSG = 0x01;
const KIND_TERMINATE = 0x02;
const KIND_WORKER_ERROR = 0x03;

type PostMessageToWorker = (workerId: number, bytes: Uint8Array) => void;
type PostMessageFromWorker = (bytes: Uint8Array) => void;
type PostControlToWorker = (workerId: number, kind: number, controlBytes: Uint8Array) => void;
type PostControlFromWorker = (kind: number, controlBytes: Uint8Array) => void;

function prependKindByte(kind: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + bytes.byteLength);
  out[0] = kind;
  out.set(bytes, 1);
  return out;
}

function installPostMessageGlobals(): void {
  // Parent-side: send a message to a specific child by workerId.
  const toWorker: PostMessageToWorker = (workerId, bytes) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgePostMessageToWorker: host RPC sync client not attached");
    }
    const tagged = prependKindByte(KIND_USER_DATA, bytes);
    const payload = new Uint8Array(4 + 4 + tagged.byteLength);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, workerId, true);
    dv.setUint32(4, tagged.byteLength, true);
    payload.set(tagged, 8);
    const reply = hostRpcSyncClient.callSync(
      OP_WORKER_POST_MESSAGE_TO_CHILD, hostWorkerId, 0, payload,
    );
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = new TextDecoder().decode(reply.payload) || `post-to-worker status=${reply.status}`;
      throw new Error("__edgePostMessageToWorker: " + msg);
    }
  };
  (globalThis as { __edgePostMessageToWorker?: PostMessageToWorker }).__edgePostMessageToWorker = toWorker;

  // Parent-side control sender — same bus, distinct kind byte the
  // dispatcher routes to __edgeDispatchControlToChild instead of the
  // user 'message' path.
  const toControlWorker: PostControlToWorker = (workerId, kind, controlBytes) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgePostControlToWorker: host RPC sync client not attached");
    }
    if (kind === KIND_USER_DATA) {
      throw new Error("__edgePostControlToWorker: kind 0x00 is reserved for user data");
    }
    const tagged = prependKindByte(kind, controlBytes);
    const payload = new Uint8Array(4 + 4 + tagged.byteLength);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, workerId, true);
    dv.setUint32(4, tagged.byteLength, true);
    payload.set(tagged, 8);
    const reply = hostRpcSyncClient.callSync(
      OP_WORKER_POST_MESSAGE_TO_CHILD, hostWorkerId, 0, payload,
    );
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = new TextDecoder().decode(reply.payload) || `post-control-to-worker status=${reply.status}`;
      throw new Error("__edgePostControlToWorker: " + msg);
    }
  };
  (globalThis as { __edgePostControlToWorker?: PostControlToWorker }).__edgePostControlToWorker = toControlWorker;

  // Child-side: send a message back to the parent.  No workerId here —
  // main derives the routing target from the source host's id via the
  // userWorkers registry.
  const fromWorker: PostMessageFromWorker = (bytes) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgePostMessageFromWorker: host RPC sync client not attached");
    }
    const tagged = prependKindByte(KIND_USER_DATA, bytes);
    const payload = new Uint8Array(4 + tagged.byteLength);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, tagged.byteLength, true);
    payload.set(tagged, 4);
    const reply = hostRpcSyncClient.callSync(
      OP_WORKER_POST_MESSAGE_TO_PARENT, hostWorkerId, 0, payload,
    );
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = new TextDecoder().decode(reply.payload) || `post-to-parent status=${reply.status}`;
      throw new Error("__edgePostMessageFromWorker: " + msg);
    }
  };
  (globalThis as { __edgePostMessageFromWorker?: PostMessageFromWorker }).__edgePostMessageFromWorker = fromWorker;

  // Child-side control sender — same routing as fromWorker but tagged.
  const fromControlWorker: PostControlFromWorker = (kind, controlBytes) => {
    if (!hostRpcSyncClient) {
      throw new Error("__edgePostControlFromWorker: host RPC sync client not attached");
    }
    if (kind === KIND_USER_DATA) {
      throw new Error("__edgePostControlFromWorker: kind 0x00 is reserved for user data");
    }
    const tagged = prependKindByte(kind, controlBytes);
    const payload = new Uint8Array(4 + tagged.byteLength);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, tagged.byteLength, true);
    payload.set(tagged, 4);
    const reply = hostRpcSyncClient.callSync(
      OP_WORKER_POST_MESSAGE_TO_PARENT, hostWorkerId, 0, payload,
    );
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = new TextDecoder().decode(reply.payload) || `post-control-to-parent status=${reply.status}`;
      throw new Error("__edgePostControlFromWorker: " + msg);
    }
  };
  (globalThis as { __edgePostControlFromWorker?: PostControlFromWorker }).__edgePostControlFromWorker = fromControlWorker;

  // Expose kind constants so the policy patch can name them rather than
  // hardcoding magic numbers.  Kept as a plain object instead of
  // individual globals to keep the global namespace tidy.
  (globalThis as { __edgePmKind?: Record<string, number> }).__edgePmKind = {
    USER_DATA: KIND_USER_DATA,
    PORT_MSG: KIND_PORT_MSG,
    TERMINATE: KIND_TERMINATE,
    WORKER_ERROR: KIND_WORKER_ERROR,
  };

  // Phase 2: expose marshal pack/unpack as globals so the policy
  // patch's JS string (which runs in this wasm runtime's V8 realm)
  // can serialize JS values into the wire format
  // `cross-context-marshal.ts` defines.  The policy can't import TS
  // modules; calling these globals is its only path to marshaling.
  //
  // Phase 4 (e33): signatures extended with optional transferList /
  // portFactory for cross-worker MessagePort transfer.  Existing
  // phase-2 callers (passing no transfer args) are unaffected.
  type PackFn = (
    value: unknown,
    transferList?: unknown[],
    assignPortId?: (port: object) => number | { id: number; originWorkerId: number } | null,
  ) => Uint8Array;
  type UnpackFn = (
    bytes: Uint8Array,
    decodePort?: (portId: number, originWorkerId: number) => unknown,
  ) => unknown;
  (globalThis as { __edgePackPostMessage?: PackFn }).__edgePackPostMessage =
    packPostMessage;
  (globalThis as { __edgeUnpackPostMessage?: UnpackFn }).__edgeUnpackPostMessage =
    unpackPostMessage;
}

// Worker-threads phase 1: user-worker bootstrap state.  Set when main
// posts `edge-user-worker-bootstrap` to a child wasm runtime worker
// (which it does INSTEAD of `start` for user-workers).  The boot path
// reads these to: (a) skip fetch+compile by using sharedWasmModule,
// (b) set userScript to require the srcPath after edge boots,
// (c) post `user-worker-exit` to main after _start finishes.
let sharedWasmModule: WebAssembly.Module | null = null;
let userWorkerMode: { workerId: number; bootstrapScript: string; workerData: Uint8Array } | null = null;

// P3.9: structured-clone IPC port (paired with host worker's half).
// Used when spawn(..., { serialization: 'advanced' }) creates a
// ChildProcess: cp.send / 'message' route through this port instead
// of the byte-stream RPC, giving full V8 postMessage fidelity
// (Map/Set/Date/ArrayBuffer/circular refs all preserved).
// Protocol implementation lives in ipc-structured-port.ts -- shared
// with the host-worker side which uses the symmetric setup.
const ipcStructuredChildHandlers = new Map<number, (msg: unknown) => void>();
const ipcStructuredDisconnectHandlers = new Map<number, () => void>();
let ipcStructuredOutbound: { send: (childId: number, msg: unknown, transfer?: Transferable[]) => boolean; disconnect: (childId: number) => boolean } | null = null;
function attachIpcStructuredPort(port: MessagePort): void {
  if (ipcStructuredOutbound) {
    post("log", { text: "[runtime] ipc-structured-port received twice; replacing", level: "warn" });
  }
  ipcStructuredOutbound = attachStructuredPort(port, {
    onMessage(childId, msg) {
      const handler = ipcStructuredChildHandlers.get(childId);
      if (handler) handler(msg);
    },
    onDisconnect(childId) {
      const cb = ipcStructuredDisconnectHandlers.get(childId);
      if (cb) {
        ipcStructuredDisconnectHandlers.delete(childId);
        try { cb(); } catch (_e) { void _e; }
      }
    },
  });
  // Expose to JS land for the child-process policy to use.
  type IpcRegister = (childId: number, onMessage: (msg: unknown) => void, onDisconnect: () => void) => void;
  type IpcUnregister = (childId: number) => void;
  const send = (childId: number, msg: unknown, transfer?: Transferable[]): boolean =>
    ipcStructuredOutbound ? ipcStructuredOutbound.send(childId, msg, transfer) : false;
  const disconnect = (childId: number): boolean =>
    ipcStructuredOutbound ? ipcStructuredOutbound.disconnect(childId) : false;
  const register: IpcRegister = (childId, onMessage, onDisconnect) => {
    ipcStructuredChildHandlers.set(childId, onMessage);
    ipcStructuredDisconnectHandlers.set(childId, onDisconnect);
  };
  const unregister: IpcUnregister = (childId) => {
    ipcStructuredChildHandlers.delete(childId);
    ipcStructuredDisconnectHandlers.delete(childId);
  };
  (globalThis as { __edgeChildProcessIpcStructuredSend?: typeof send }).__edgeChildProcessIpcStructuredSend = send;
  (globalThis as { __edgeChildProcessIpcStructuredDisconnect?: typeof disconnect }).__edgeChildProcessIpcStructuredDisconnect = disconnect;
  (globalThis as { __edgeChildProcessIpcStructuredRegister?: IpcRegister }).__edgeChildProcessIpcStructuredRegister = register;
  (globalThis as { __edgeChildProcessIpcStructuredUnregister?: IpcUnregister }).__edgeChildProcessIpcStructuredUnregister = unregister;
}

// ESM source-publish ack registry — token-keyed pending Promises
// awaited by `napi-host/esm-registry.ts` when it falls back from the
// blob-URL path to the SW path for cyclic graphs.  Publish ack arrives
// via the page (worker → page → SW → page → worker) because direct
// DedicatedWorker → SW postMessage is unreliable across browsers.
const esmPublishPending = new Map<string, {
  resolve: () => void;
  reject: (e: unknown) => void;
}>();

(globalThis as {
  __edgeEsmPublishSources?: (sources: Array<[string, string]>) => Promise<void>;
}).__edgeEsmPublishSources = (sources: Array<[string, string]>): Promise<void> => {
  if (sources.length === 0) return Promise.resolve();
  const token = "esm-" + Math.random().toString(36).slice(2) + "-" + nowMs();
  return new Promise<void>((resolve, reject) => {
    esmPublishPending.set(token, { resolve, reject });
    self.postMessage({ kind: "edge-esm-publish", sources, token });
    // 5s timeout — SW shouldn't take this long; the only way it
    // does is if main.ts hasn't activated the SW yet.  Reject with
    // a clear error so the napi handler surfaces it.
    setTimeout(() => {
      const slot = esmPublishPending.get(token);
      if (!slot) return;
      esmPublishPending.delete(token);
      slot.reject(new Error("edge ESM SW publish timed out (5s)"));
    }, 5000);
  });
};

self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as { kind?: string; sab?: SharedArrayBuffer; requestSab?: SharedArrayBuffer; replySab?: SharedArrayBuffer; hostWorkerId?: number } | null;
  if (data?.kind === "edge-esm-published") {
    const token = (data as { token?: string }).token;
    if (!token) return;
    const slot = esmPublishPending.get(token);
    if (!slot) return;
    esmPublishPending.delete(token);
    const err = (data as { error?: string }).error;
    if (err) slot.reject(new Error(err));
    else slot.resolve();
    return;
  }
  if (data?.kind === "edge-fs-snapshot-sab" && data.sab) {
    fsSnapshotSab = data.sab;
  } else if ((data as { kind?: string })?.kind === "edge-ipc-structured-port") {
    // P3.9: structured-clone IPC port (paired with the half on the host
    // worker). Used by child-process IPC when serialization:'advanced'
    // is requested. Stash + wire dispatch.
    const port = (data as { port: MessagePort }).port;
    attachIpcStructuredPort(port);
  } else if (data?.kind === "edge-host-rpc-sab" && data.requestSab && data.replySab) {
    hostWorkerId = data.hostWorkerId ?? 0;
    // Expose to JS land (policy patches use this to set originWorkerId
    // when allocating port-IDs — items 2-full and 3 of e33).
    (globalThis as { __edgeHostWorkerId?: number }).__edgeHostWorkerId = hostWorkerId;
    const requestRing = attachHostRing(data.requestSab, HOST_RPC_RING_CONFIG);
    const replyRing = attachHostRing(data.replySab, HOST_RPC_RING_CONFIG);
    hostRpcClient = new RpcClient(requestRing, replyRing);
    post("log", { text: `[runtime] host RPC client attached (hostWorkerId=${hostWorkerId})`, level: "info" });
    // E18: sync forward client on the same rings.  sharedWake is wired
    // a few lines below — we re-construct after it lands; until then
    // hostRpcSyncClient stays null and the digest global gracefully
    // throws if called early.
    // F-2: attach view onto host's napi memory.
    const napiMemSab = (data as { napiMemorySab?: SharedArrayBuffer }).napiMemorySab;
    if (napiMemSab) {
      hostNapiMemoryView = new Uint32Array(napiMemSab);
      // E22: byte-level view over the same SAB.  __edgeHostDigestSync
      // copies user input into the digest staging region of this view
      // before sending OP_SUBTLE_DIGEST_VIA_NAPI_MEM — that's how we
      // get past the 4 KiB single-slot wire limit.
      hostNapiMemoryBytes = new Uint8Array(napiMemSab);
      post("log", { text: `[runtime] host napi memory attached (${napiMemSab.byteLength} bytes)`, level: "info" });
    }
    // F-9 path-a: attach shared-wake view.  Used by SyncRpcClient
    // construction (callback-arg napi op factories) so the wait loop
    // can be woken by host reverse-request publishes.
    const sharedWakeSab = (data as { sharedWakeSab?: SharedArrayBuffer }).sharedWakeSab;
    if (sharedWakeSab) {
      sharedWake = { i32: new Int32Array(sharedWakeSab), idx: 0 };
      post("log", { text: `[runtime] shared-wake SAB attached (${sharedWakeSab.byteLength} bytes)`, level: "info" });
    }
    // E18: forward sync client on the host RPC rings.  Uses the same
    // shared-wake address as the existing async client; the sync
    // variant blocks via Atomics.wait while host replies arrive.
    //
    // drainReverseRequests bridges the reverseRpcServer (registered
    // below) into the sync wait loop. Without it, while wasm is parked
    // on Atomics.wait for a forward reply, the reverse-request ring
    // accumulates messages (cp.send bursts, finalizers, async events).
    // Once the ring is full (256 slots), host's reverseClient.call
    // backs off and after ~6s of retries silently DROPS the event.
    // The drainer ensures inbound reverse requests are processed
    // synchronously during the wait, freeing ring slots for the host
    // to keep publishing. See NOTES.md "host-rpc-sync-reverse-drain".
    hostRpcSyncClient = new SyncRpcClient(
      requestRing,
      replyRing,
      sharedWake,
      () => { reverseRpcServer?.drainOnce(); },
    );
    // Install the `__edgeHostDigestSync(algoName, bytes) → Uint8Array`
    // global the `crypto-hash-via-host-worker` policy reads.  Keeps the
    // policy code engine-agnostic — Node harness installs its own
    // synchronous implementation via this same global.
    installHostDigestSyncGlobal();
    installHostHmacSyncGlobal();
    installSpawnNodeWorkerGlobal();
    installSpawnChildProcessGlobal();
    installSpawnChildProcessAsyncGlobals();
    installPostMessageGlobals();
    // L4 reverse channel — host can send requests TO this worker.
    // Reverse-direction SABs come in the same message.
    const reverseReqSab = (data as { reverseRequestSab?: SharedArrayBuffer }).reverseRequestSab;
    const reverseRepSab = (data as { reverseReplySab?: SharedArrayBuffer }).reverseReplySab;
    if (reverseReqSab && reverseRepSab) {
      const reverseRequestRing = attachHostRing(reverseReqSab, HOST_RPC_RING_CONFIG);
      const reverseReplyRing = attachHostRing(reverseRepSab, HOST_RPC_RING_CONFIG);
      reverseRpcServer = new RpcServer(reverseRequestRing, reverseReplyRing);
      // OP_WASM_ECHO: round-trip a payload (L4 bench).
      reverseRpcServer.register(OP_WASM_ECHO, async (_ctx, args) => {
        const copy = new Uint8Array(args.byteLength);
        copy.set(args);
        return { payload: copy, status: REPLY_STATUS_OK };
      });
      // Worker-threads phase 1: parent's wasm receives this when one of
      // its child user-workers exits.  Host posts via reverse RPC; we
      // look up the JS callback registered by the user's
      // `worker.on('exit', cb)` and invoke it with the exit code.  The
      // policy patches lib's worker.js to record callbacks in a
      // globalThis map keyed by workerId.
      reverseRpcServer.register(OP_DELIVER_USER_WORKER_EXIT, async (_ctx, args) => {
        try {
          if (args.byteLength < 8) {
            return {
              payload: new TextEncoder().encode("deliver-user-worker-exit: args too short"),
              status: REPLY_STATUS_INVALID_ARGS,
            };
          }
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const workerId = dv.getUint32(0, true);
          const exitCode = dv.getUint32(4, true);
          // Phase 3c (e33+): extended payload [u32 wid][u32 code][u32 errLen][bytes err].
          // Old 8-byte messages still parse (errLen would be missing → undefined → treat as 0).
          let errorBytes: Uint8Array | null = null;
          if (args.byteLength >= 12) {
            const errLen = dv.getUint32(8, true);
            if (errLen > 0 && args.byteLength >= 12 + errLen) {
              errorBytes = new Uint8Array(args.buffer.slice(args.byteOffset + 12, args.byteOffset + 12 + errLen));
            }
          }
          type ExitDispatcher = (workerId: number, code: number, errorBytes?: Uint8Array | null) => void;
          const dispatch = (globalThis as { __edgeDispatchUserWorkerExit?: ExitDispatcher })
            .__edgeDispatchUserWorkerExit;
          if (typeof dispatch === "function") {
            dispatchOnLibuvTick("OP_DELIVER_USER_WORKER_EXIT", () => dispatch(workerId, exitCode, errorBytes));
            // Wake parent's parked poll_oneoff so worker.on('exit') /
            // 'error' verifiers fire promptly.  Unlike message paths
            // there's no uv_async slot for exit — wake notify is the
            // only path to unpark the loop here.  See Phase 7D in
            // NOTES.md / project-corpus-mustcall-hidden memory.
            (globalThis as { __edgeWakePoll?: () => void }).__edgeWakePoll?.();
          } else {
            post("log", { text: `[runtime] OP_DELIVER_USER_WORKER_EXIT #${workerId}: no dispatcher registered`, level: "warn" });
          }
          return { payload: new Uint8Array(0), status: REPLY_STATUS_OK };
        } catch (e) {
          return {
            payload: new TextEncoder().encode((e as Error).message),
            status: REPLY_STATUS_HOST_ERROR,
          };
        }
      });
      // Worker-threads phase 2: parent's wasm receives a message from a
      // child user-worker via this reverse op.  Bytes are already
      // structured-clone-marshaled (cross-context-marshal wire format);
      // we hand them off to the policy patch's dispatcher which
      // unmarshals and emits 'message' on the right Worker instance.
      reverseRpcServer.register(OP_DELIVER_MESSAGE_FROM_CHILD, async (_ctx, args) => {
        try {
          if (args.byteLength < 8) {
            return {
              payload: new TextEncoder().encode("deliver-message-from-child: args too short"),
              status: REPLY_STATUS_INVALID_ARGS,
            };
          }
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const workerId = dv.getUint32(0, true);
          const bytesLen = dv.getUint32(4, true);
          if (args.byteLength < 8 + bytesLen) {
            return {
              payload: new TextEncoder().encode("deliver-message-from-child: bytes truncated"),
              status: REPLY_STATUS_INVALID_ARGS,
            };
          }
          // The marshaled bytes view aliases the args buffer; copy so
          // the dispatcher (which may queue) owns its own memory.
          // Includes the kind tag byte at position 0 (spoof-proof
          // control envelope, see installPostMessageGlobals).
          if (bytesLen < 1) {
            return {
              payload: new TextEncoder().encode("deliver-message-from-child: missing kind byte"),
              status: REPLY_STATUS_INVALID_ARGS,
            };
          }
          const tagged = new Uint8Array(bytesLen);
          tagged.set(new Uint8Array(args.buffer, args.byteOffset + 8, bytesLen));
          const kind = tagged[0];
          const bytes = tagged.subarray(1);
          type FromChildDispatcher = (workerId: number, bytes: Uint8Array) => void;
          type FromChildControlDispatcher = (workerId: number, kind: number, controlBytes: Uint8Array) => void;
          if (kind === 0x00) {
            const dispatch = (globalThis as { __edgeDispatchMessageFromChild?: FromChildDispatcher })
              .__edgeDispatchMessageFromChild;
            if (typeof dispatch === "function") {
              dispatchOnLibuvTick("OP_DELIVER_MESSAGE_FROM_CHILD", () => dispatch(workerId, bytes));
              pokeWorkerSlot(workerId);
              (globalThis as { __edgeWakePoll?: () => void }).__edgeWakePoll?.();
            } else {
              post("log", { text: `[runtime] OP_DELIVER_MESSAGE_FROM_CHILD #${workerId}: no dispatcher registered`, level: "warn" });
            }
          } else {
            const cdispatch = (globalThis as { __edgeDispatchControlFromChild?: FromChildControlDispatcher })
              .__edgeDispatchControlFromChild;
            if (typeof cdispatch === "function") {
              dispatchOnLibuvTick("OP_DELIVER_CONTROL_FROM_CHILD", () => cdispatch(workerId, kind, bytes));
              pokeWorkerSlot(workerId);
              (globalThis as { __edgeWakePoll?: () => void }).__edgeWakePoll?.();
            } else {
              post("log", { text: `[runtime] OP_DELIVER_MESSAGE_FROM_CHILD #${workerId}: no control dispatcher (kind=0x${kind.toString(16)})`, level: "warn" });
            }
          }
          return { payload: new Uint8Array(0), status: REPLY_STATUS_OK };
        } catch (e) {
          return {
            payload: new TextEncoder().encode((e as Error).message),
            status: REPLY_STATUS_HOST_ERROR,
          };
        }
      });
      // Worker-threads phase 2: child's wasm receives a message from
      // its parent via this reverse op.  Same shape minus workerId.
      reverseRpcServer.register(OP_DELIVER_MESSAGE_TO_CHILD, async (_ctx, args) => {
        try {
          if (args.byteLength < 4) {
            return {
              payload: new TextEncoder().encode("deliver-message-to-child: args too short"),
              status: REPLY_STATUS_INVALID_ARGS,
            };
          }
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const bytesLen = dv.getUint32(0, true);
          if (args.byteLength < 4 + bytesLen) {
            return {
              payload: new TextEncoder().encode("deliver-message-to-child: bytes truncated"),
              status: REPLY_STATUS_INVALID_ARGS,
            };
          }
          // Spoof-proof envelope: byte 0 is the kind tag, rest is the
          // tagged payload (user data or control format).
          if (bytesLen < 1) {
            return {
              payload: new TextEncoder().encode("deliver-message-to-child: missing kind byte"),
              status: REPLY_STATUS_INVALID_ARGS,
            };
          }
          const tagged = new Uint8Array(bytesLen);
          tagged.set(new Uint8Array(args.buffer, args.byteOffset + 4, bytesLen));
          const kind = tagged[0];
          const bytes = tagged.subarray(1);
          type ToChildDispatcher = (bytes: Uint8Array) => void;
          type ToChildControlDispatcher = (kind: number, controlBytes: Uint8Array) => void;
          if (kind === 0x00) {
            const dispatch = (globalThis as { __edgeDispatchMessageToChild?: ToChildDispatcher })
              .__edgeDispatchMessageToChild;
            if (typeof dispatch === "function") {
              dispatchOnLibuvTick("OP_DELIVER_MESSAGE_TO_CHILD", () => dispatch(bytes));
              pokeParentPortSlot();
              (globalThis as { __edgeWakePoll?: () => void }).__edgeWakePoll?.();
            } else {
              post("log", { text: `[runtime] OP_DELIVER_MESSAGE_TO_CHILD: no dispatcher registered`, level: "warn" });
            }
          } else {
            const cdispatch = (globalThis as { __edgeDispatchControlToChild?: ToChildControlDispatcher })
              .__edgeDispatchControlToChild;
            if (typeof cdispatch === "function") {
              dispatchOnLibuvTick("OP_DELIVER_CONTROL_TO_CHILD", () => cdispatch(kind, bytes));
              pokeParentPortSlot();
              (globalThis as { __edgeWakePoll?: () => void }).__edgeWakePoll?.();
            } else {
              post("log", { text: `[runtime] OP_DELIVER_MESSAGE_TO_CHILD: no control dispatcher (kind=0x${kind.toString(16)})`, level: "warn" });
            }
          }
          return { payload: new Uint8Array(0), status: REPLY_STATUS_OK };
        } catch (e) {
          return {
            payload: new TextEncoder().encode((e as Error).message),
            status: REPLY_STATUS_HOST_ERROR,
          };
        }
      });
      // Async child_process spawn() events: host pushes stdout/stderr
      // chunks + exit/error/spawned events as the executor produces
      // them. Dispatch to JS via __edgeChildProcessAsyncEvent so the
      // policy patch's ChildProcess facade can wire to streams + emit.
      reverseRpcServer.register(OP_SPAWN_ASYNC_EVENT, async (_ctx, args) => {
        try {
          if (args.byteLength < 5) {
            return {
              payload: new TextEncoder().encode("spawn-async-event: args too short"),
              status: REPLY_STATUS_INVALID_ARGS,
            };
          }
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const childId = dv.getUint32(0, true);
          const kind = args[4];
          const payload = new Uint8Array(args.byteLength - 5);
          payload.set(args.subarray(5));
          type AsyncEventDispatcher = (childId: number, kind: number, payload: Uint8Array) => void;
          const dispatch = (globalThis as { __edgeChildProcessAsyncEvent?: AsyncEventDispatcher })
            .__edgeChildProcessAsyncEvent;
          if (typeof dispatch === "function") {
            // Run on the libuv tick so the EE 'data' callbacks fire
            // inside a proper event-loop turn (matches Node's pattern
            // of emitting data events as macrotasks from uv_read_cb).
            dispatchOnLibuvTick("OP_SPAWN_ASYNC_EVENT", () => dispatch(childId, kind, payload));
          }
          return { payload: new Uint8Array(0), status: REPLY_STATUS_OK };
        } catch (e) {
          return {
            payload: new TextEncoder().encode((e as Error).message),
            status: REPLY_STATUS_HOST_ERROR,
          };
        }
      });
      void reverseRpcServer.start().catch((err) => {
        post("log", { text: `[runtime] reverse RPC server crashed: ${(err as Error).message}`, level: "err" });
      });
      post("log", { text: "[runtime] reverse RPC server attached", level: "info" });
    }
    // L2 proof-of-life: ping the host worker once at attach time.
    void hostRpcClient.call(OP_PING, hostWorkerId, 0, null).then((res) => {
      post("log", { text: `[runtime] host ping ok status=${res.status} replyBytes=${res.payload.byteLength}`, level: "info" });
    }).catch((err) => {
      post("log", { text: `[runtime] host ping FAILED: ${(err as Error).message}`, level: "err" });
    });
    // F-2: runtime worker now has hostNapiMemoryView attached.  The
    // shared memory bridge is established.  Verifying that runtime
    // worker can ACTUALLY read host's writes via RPC is page-driven
    // (probe-f2-mem-bridge.mjs runs the cross-worker read from page,
    // not from inside the wasm runtime worker — that worker enters
    // JSPI suspend during edge.js boot and its event loop pauses,
    // which would race with any RPC probe issued from here).
  }
});

async function runHelloSmokeTest() {
  post("section", { text: "── hello.wasm (smoke test) ──" });
  const resp = await fetch("/hello.wasm");
  const wasmBytes = await resp.arrayBuffer();
  post("log", { text: `fetched hello.wasm (${wasmBytes.byteLength} bytes)`, level: "info" });

  const memoryHolder: { memory: WebAssembly.Memory | null } = { memory: null };

  const shim = createWasiShim({
    get memory() {
      if (!memoryHolder.memory) throw new Error("memory not ready");
      return memoryHolder.memory;
    },
    args: ["hello"],
    env: {},
    fs: createBundledFs(),
    postLog: (text: string, level?: string) => {
      if (level === "out") {
        post("log", { text: `[stdout] ${text}`, level: "out" });
      } else {
        post("log", { text, level: level ?? "info" });
      }
    },
    postExit: () => { /* handled via ExitSignal */ },
  } as never);

  const t0 = nowMs();
  const instance = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: shim.wasi_snapshot_preview1 as Record<string, WebAssembly.ImportValue>,
  });
  memoryHolder.memory = (instance.instance.exports as { memory: WebAssembly.Memory }).memory;
  post("log", { text: `instantiated in ${(nowMs() - t0).toFixed(0)} ms`, level: "info" });

  try {
    (instance.instance.exports._start as () => void)();
    post("log", { text: "_start returned without proc_exit", level: "warn" });
  } catch (e) {
    if (e instanceof ExitSignal) {
      post("log", { text: `✓ end-to-end success (exit=${e.code})`, level: e.code === 0 ? "out" : "info" });
    } else {
      post("log", { text: `threw: ${(e as Error).stack ?? e}`, level: "err" });
    }
  }
}

async function runEdgeWithEmnapi() {
  post("section", { text: "── edgejs.wasm (emnapi + WASI host) ──" });
  const trace = new Trace();
  // Page may opt out of per-call tracing via ?trace=0.  Tracing
  // allocates args/return objects on every wasi import (~25k+ per
  // HTTP request), so skipping it is a real perf win for benchmarks
  // and production.
  if (traceDisabled) {
    trace.disabled = true;
    post("log", { text: "[worker] tracing disabled (?trace=0)", level: "info" });
  }

  // E24 + worker-threads phase 1: if we received a pre-compiled
  // WebAssembly.Module via `edge-user-worker-bootstrap`, skip the fetch
  // and compile entirely — saves ~22 ms per spawned child (verified
  // by E24).  Module is structured-cloneable; compiled code is shared
  // across worker boundary per Chromium's postMessage semantics.
  let wasmBytes: ArrayBuffer | null = null;
  if (!sharedWasmModule) {
    const resp = await fetch("/edgejs.wasm");
    wasmBytes = await resp.arrayBuffer();
    post("log", { text: `fetched edgejs.wasm (${(wasmBytes.byteLength / 1_000_000).toFixed(1)} MB)`, level: "info" });
  } else {
    post("log", { text: "[worker-threads] using shared pre-compiled wasm Module (E24)", level: "info" });
  }

  const memory = new WebAssembly.Memory({ initial: 337, maximum: 65536, shared: true });
  post("log", {
    text: `memory: ${memory.buffer.byteLength / 65536} pages, shared=${memory.buffer instanceof SharedArrayBuffer}`,
    level: "info",
  });

  // emnapi host — provides standard napi_* + env helpers + our unofficial_napi_*.
  // Policies are the deployment-time strategy bundle: see policies/index.ts
  // for the framework and `defaultBrowserPolicies` for the rationale of each
  // member.  Worker-only deployments can fork this list — e.g. append an
  // outbound-fetch-tunnel policy to enable client-side http.request.
  // Feature-detect JSPI first so policy composition can opt into
  // host-async-dependent policies (compression-via-compressionstream).
  const hasJspi = typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending === "function"
    && typeof (WebAssembly as unknown as { promising?: unknown }).promising === "function";

  // Compose the browser policies.  Note: compression-via-compressionstream
  // is registered but NOT enabled by default — it triggers a JSPI
  // architectural issue (any async JS path that re-enters wasm needs
  // its caller wrapped with WebAssembly.promising).  Tracked separately.
  void compressionViaCompressionStream;
  // Extra opt-in policies from `?policies=name1,name2` on the page.
  // Unknown names are warned and ignored.
  const extraPolicies = extraPolicyNames
    .map((n) => {
      const p = policyRegistry[n];
      if (!p) post("log", { text: `[policies] unknown policy name "${n}" (ignored)`, level: "warn" });
      return p;
    })
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  // Migration in progress: defaultBrowserPolicies still contains legacy
  // Policy objects from src/policies/.  We filter out the ones already
  // migrated into src/edge-env/presets/ and add the native versions.
  // Once every policy is migrated, drop the filter and the import from
  // ./policies entirely.
  const migratedNames = new Set<string>([
    v8Serdes.name, "v8-serdes-shim",
    bufferPoolDisable.name,
    taskQueueEnqueueFix.name,
    inboundHttpsViaSW.name,
    outboundThrow.name,
    outboundFetchTunnel.name,
    processExitTerminates.name,
    processMethodsWasmState.name,
    fastReadFile.name,
    wasmCompileViaHost.name,
    bufferWriteSync.name,
    zlibWriteStateWasm.name,
    zlibInitParamsWasm.name,
    compressionViaCompressionStreamPreset.name,
    cryptoHostRandom.name,
    cryptoViaSubtle.name,
    cryptoHashViaHostWorker.name,
    cryptoHmacViaHostWorker.name,
    esmViaBlobImport.name,
    esmRequirePreeval.name,
    esmRequireSucraseBackstop.name,
    bufferWasmAliased.name,
    childProcessViaExecutor.name,
    workerThreadsPerThread.name,
    bufferBase64.name,
    bufferCopy.name,
    vmSameRealm.name,
    pollWakeOnSchedule.name,
    utilGetOwnNonIndexProperties.name,
    utilTypesAsyncGen.name,
    utilGetProxyDetails.name,
    utilGetConstructorName.name,
    osPriorityStateful.name,
    stringDecoderJs.name,
  ]);
  const legacyPolicies = [...defaultBrowserPolicies, ...extraPolicies]
    .filter((p) => !migratedNames.has(p.name));
  const nativePresets = [
    v8Serdes,
    bufferPoolDisable,
    taskQueueEnqueueFix,
    inboundHttpsViaSW,
    outboundThrow,
    outboundFetchTunnel,
    processExitTerminates,
    processMethodsWasmState,
    fastReadFile,
    wasmCompileViaHost,
    bufferWriteSync,
    zlibWriteStateWasm,
    zlibInitParamsWasm,
    compressionViaCompressionStreamPreset,
    cryptoHostRandom,
    cryptoViaSubtle,
    cryptoHashViaHostWorker,
    cryptoHmacViaHostWorker,
    esmViaBlobImport,
    esmRequirePreeval,
    esmRequireSucraseBackstop,
    bufferWasmAliased,
    childProcessViaExecutor,
    workerThreadsPerThread,
    bufferBase64,
    bufferCopy,
    vmSameRealm,
    pollWakeOnSchedule,
    utilGetOwnNonIndexProperties,
    utilTypesAsyncGen,
    utilGetProxyDetails,
    utilGetConstructorName,
    osPriorityStateful,
    stringDecoderJs,
  ];
  // buffer-base64 preset's runtime patch calls globalThis.__edgeDecodeBase64
  // to run the vendored unenv/base64-js decoder.  Install BEFORE the napi
  // host boots so the patch can find it when lib/buffer.js loads.
  (globalThis as unknown as { __edgeDecodeBase64?: typeof decodeBase64 })
    .__edgeDecodeBase64 = decodeBase64;
  const { env } = defineEdgeEnv({
    presets: [...legacyPolicies.map(asPreset), ...nativePresets],
  });
  const { builtinOverrides, userScriptPrelude, applied: appliedPolicies } =
    toLegacyShape(env);
  void composePolicies;  // suppress unused-import until migration completes
  void hasJspi;
  // E9: requestExit holder — populated after createWasiShim below so
  // wasm-side `unofficial_napi_terminate_execution` can wake a parked
  // poll_oneoff.  See experiments/e9-process-exit-in-fr/FINDINGS.md.
  const requestExitHolder: { fn?: (code: number) => void } = {};
  const napi = createNapiHost({ memory, builtinOverrides, postLog: (text, level) => post("log", { text, level }), requestExitHolder });
  post("log", { text: `policies applied: ${appliedPolicies.join(", ")}`, level: "info" });
  post("log", { text: `napi-host: ${Object.keys(napi.imports.napi).length} napi entries seeded`, level: "info" });

  // FileSystem facade.  Runtime worker only keeps a minimal bundled-fs
  // for legacy paths (mostly /dev/* probes during boot).  Real file I/O
  // routes through the SAB-backed snapshot — pool workers (and runtime
  // itself) open via the snapshot's reader path; the bridge worker
  // owns the layered (bundled + opfs) adapter and drives the loader.
  const fs = createBundledFs({
    log: (line) => post("log", { text: line, level: "info" }),
  });

  // Pick yield strategy: JSPI if WebAssembly.Suspending is available
  // (Chrome 137+, Node 24+ with flags), else sync (Atomics.wait).
  let yieldStrategy: YieldStrategy = syncYieldStrategy;
  let entryPointWrapper: (fn: Function) => Function = (fn) => fn;
  if (hasJspi) {
    const { jspiYieldStrategy } = await import("./wasi-shim/yield-jspi");
    yieldStrategy = jspiYieldStrategy;
    entryPointWrapper = (fn) => jspiYieldStrategy.wrapExport(fn);
    post("log", { text: "[worker] JSPI available — using jspiYieldStrategy", level: "info" });
  } else {
    post("log", { text: "[worker] JSPI unavailable — falling back to syncYieldStrategy (Atomics.wait)", level: "info" });
  }

  // Cross-thread pipe registry — SAB shared with every worker we spawn
  // so libuv's uv_async_send (pool → main wake, a pipe write internally)
  // actually reaches main.  See `wasi-shim/pipes-sab.ts`.
  const pipeRegistry = PipeRegistry.create();

  // Cross-thread file snapshot — SAB-backed read-only file table
  // shared with the bridge worker (loader) and pool workers (readers).
  // Runtime worker attaches as a reader only — it does NOT run the
  // drain loop (would deadlock its own wasm on Atomics.wait if a
  // re-entry triggered a cold-miss).  Bridge worker drives the
  // loader; see bridge-worker.ts.
  //
  // The SAB was created by the bridge worker and forwarded to us via
  // main.ts ("edge-fs-snapshot-sab" message).  Must be present before
  // we hit this point — main.ts spawns bridge first and waits for its
  // ready signal.
  if (!fsSnapshotSab) {
    post("log", { text: "[runtime] fs snapshot SAB not received from bridge worker", level: "err" });
    return;
  }
  const fsSnapshot = FsSnapshotRegistry.attach(fsSnapshotSab);

  // Diagnostic: dump main-side pipe activity periodically while we're
  // bringing this up.  Pool workers post their own stats via
  // thread-log.  Quiet when there's no activity — we only care that the
  // pipe primitive is exercised under the /_edge/* test paths.
  let _lastPipeStats = "";
  setInterval(() => {
    const s = pipeRegistry.stats();
    const tag = `w=${s.wCount}/${s.wBytes}B r=${s.rCount}/${s.rBytes}B`;
    if (tag !== _lastPipeStats && (s.wCount > 0 || s.rCount > 0)) {
      _lastPipeStats = tag;
      post("log", { text: `[pipes-main] ${tag}`, level: "info" });
    }
  }, 1500);

  // Wasi shim — provides wasi_snapshot_preview1, wasix_32v1, wasi.thread-spawn
  // and a SocketBus we wire to the HTTP bridge port below.
  const shim = createWasiShim({
    memory,
    yieldStrategy,
    pipeRegistry,
    fsSnapshot,
    // Runtime worker is a *reader* of the snapshot.  Bridge worker
    // owns the loader role; runtime's own opens that miss the cache
    // will Atomics.wait on the slot status — that's safe because the
    // notify comes from bridge worker (a different thread), so we
    // don't deadlock on our own loop.
    fsSnapshotRole: "reader",
    // Small HTTP server: opens a TCP listener on :3000, replies to any
    // request with "hi from edge\n".  The path/port are not used for
    // routing — the SW intercepts /_edge/* and pushes any request onto
    // whatever listener edge has open (single-listener policy, see
    // wasi-shim.ts).
    //
    // `userScriptPrelude` is prepended by the active policy set — at
    // minimum it contains the Buffer.poolSize=0 hack (see
    // policies/buffer-pool-disable.ts) plus any other monkey-patches the
    // active policies install.
    //
    // `--experimental-vm-modules` unlocks vm.SourceTextModule /
    // vm.SyntheticModule at runtime so the ESM stubs in
    // `napi-host/unofficial.ts` (driven by the blob-URL trampoline)
    // can be exercised from tests without filesystem fixtures.  The
    // flag has zero effect on programs that don't touch vm modules;
    // its only side effect is patching `vm.Module` etc. in
    // `lib/internal/process/pre_execution.js:setupVmModules()`.
    args: ["edgejs", "--experimental-vm-modules", "--expose-internals", "-e", userScriptPrelude + (userScript ?? `
      const http = require('http');
      const fs = require('fs');
      const server = http.createServer((req, res) => {
        if (req.url === '/fs-cb') {
          fs.readFile('/node/deps/undici/src/package.json', (err, buf) => {
            if (err) { res.statusCode = 500; res.end('fs.readFile-cb err: ' + err.message + '\\n'); return; }
            res.end('fs.readFile-cb ok len=' + buf.length + '\\n');
          });
        } else if (req.url === '/fs') {
          fs.promises.readFile('/node/deps/undici/src/package.json')
            .then(buf => res.end('fs.readFile ok len=' + buf.length + '\\n'))
            .catch(err => { res.statusCode = 500; res.end('fs.readFile err: ' + err.message + '\\n'); });
        } else if (req.url === '/fs-sync') {
          try {
            const buf = fs.readFileSync('/node/deps/undici/src/package.json');
            res.end('fs.readFileSync ok len=' + buf.length + '\\n');
          } catch (err) {
            res.statusCode = 500;
            res.end('fs.readFileSync err: ' + err.message + '\\n');
          }
        } else if (req.url === '/fs-open') {
          fs.open('/node/deps/undici/src/package.json', 'r', (err, fd) => {
            if (err) { res.statusCode = 500; res.end('fs.open err: ' + err.message + '\\n'); return; }
            fs.close(fd, () => res.end('fs.open+close ok fd=' + fd + '\\n'));
          });
        } else if (req.url === '/fs-readonly') {
          // open sync, read async — isolates the cost of one async read
          // call (which should be fastfs short-circuited).
          let fd;
          try { fd = fs.openSync('/node/deps/undici/src/package.json', 'r'); } catch (e) { res.statusCode = 500; res.end('fs.openSync err: ' + e.message + '\\n'); return; }
          const buf = Buffer.alloc(8192);
          fs.read(fd, buf, 0, 8192, 0, (err, bytesRead) => {
            try { fs.closeSync(fd); } catch {}
            if (err) { res.statusCode = 500; res.end('fs.read err: ' + err.message + '\\n'); return; }
            res.end('fs.read async ok bytes=' + bytesRead + '\\n');
          });
        } else if (req.url === '/write') {
          const payload = 'hello-from-write-' + Date.now();
          fs.writeFile('/tmp/edge-write-test.txt', payload, (err) => {
            if (err) { res.statusCode = 500; res.end('writeFile err: ' + err.message + '\\n'); return; }
            fs.readFile('/tmp/edge-write-test.txt', 'utf-8', (e2, data) => {
              if (e2) { res.statusCode = 500; res.end('readBack err: ' + e2.message + '\\n'); return; }
              res.end('write+read ok wrote=' + payload.length + 'B read=' + data.length + 'B match=' + (data === payload) + '\\n');
            });
          });
        } else if (req.url === '/randomFill') {
          require('crypto').randomFill(Buffer.alloc(32), (err, buf) => {
            if (err) { res.statusCode = 500; res.end('randomFill err: ' + err.message + '\\n'); return; }
            res.end('randomFill ok hex=' + buf.toString('hex') + '\\n');
          });
        } else {
          res.end('hi from edge\\n');
        }
      });
      // Disable keep-alive so the post-response timer doesn't pin
      // the libuv loop between sequential requests.  Was holding ~1s
      // gap between /_edge/fs requests because Node was waiting for
      // either a follow-up request or keepAliveTimeout expiry.
      server.keepAliveTimeout = 0;
      server.headersTimeout = 0;
      server.listen(3000, () => console.log('listening'));
    `)],
    // Match native napi_wasmer baseline — wasmer-wasix passes no env by
    // default and edge boots fine.  Adding env vars made wasi-libc trigger
    // a different init path that breaks uv_cwd downstream.
    env: {},
    fs,
    postLog: (text, level) => {
      if (level === "out") post("log", { text: `[stdout] ${text}`, level: "out" });
      else if (level === "warn") post("log", { text: `[stderr] ${text}`, level: "warn" });
      else post("log", { text, level: level ?? "info" });
    },
    postExit: () => { /* via ExitSignal */ },
  });

  // E9: now that both napi-host and wasi-shim exist, wire wasm-side
  // process.exit() to wake the shim's parked poll_oneoff.  See
  // experiments/e9-process-exit-in-fr/FINDINGS.md.
  requestExitHolder.fn = shim.requestExit;

  // Phase 7A — expose the wake primitive globally so the
  // poll-wake-on-schedule preset's pre-patch on internal/timers can
  // notify the parked poll_oneoff after lib queues a timer or first
  // immediate.  Without this, host-JS-driven setTimeout / setImmediate
  // wait up to ~30s (the Atomics.wait default) for poll_oneoff to time
  // out before the timer fires.  See investigation in NOTES.md
  // `corpus-mustcall-not-verified`.  Race-free under Atomics — a notify
  // on an idle slot is a no-op; a notify on a parked wait wakes it.
  const wakeView = shim.bus.wakeView;
  (globalThis as unknown as { __edgeWakePoll?: () => void })
    .__edgeWakePoll = () => {
      Atomics.add(wakeView, 0, 1);
      Atomics.notify(wakeView, 0);
    };

  // Preset-applied tracker — primitive for diagnosing whether a preset's
  // pre/post patch body actually executed at module-load time.  Subagents
  // (and humans) authoring presets call `globalThis.__edgePresetApplied('preset-name')`
  // as the first line of their IIFE; the call lands here, posts the
  // breadcrumb via opts.postLog (which survives bootstrap), and tracks
  // the unique names so we can emit a summary line at first user-script
  // entry.  Strictly diagnostic — has no functional effect on lib
  // behavior.  See agent-prompt guidance in NOTES.md.
  const appliedPresets = new Set<string>();
  (globalThis as unknown as { __edgePresetApplied?: (name: string) => void })
    .__edgePresetApplied = (name: string) => {
      if (typeof name !== "string" || appliedPresets.has(name)) return;
      appliedPresets.add(name);
      post("log", { text: `[preset-applied] ${name}`, level: "warn" });
    };

  // Wire the bridge to the socket bus.  Two channels:
  //   1) The page (relaying for the SW) writes incoming HTTP requests
  //      into bridgeSab and calls Atomics.notify on the shim's wakeView.
  //      The shim blocks on wakeView[0] inside accept_v2; our wakePoll
  //      hook reads from bridgeSab and pushes the request through the
  //      bus once it wakes.
  //   2) The shim's responder fires when a connection closes with
  //      response bytes.  We post {kind:"page-edge-res"} to the main
  //      thread; main.ts forwards to the SW via sw.postMessage.
  shim.bus.setResponder((res) => {
    // res.body is a Uint8Array (subarray of recvBuf or fresh allocation).
    // Copy to a plain ArrayBuffer so postMessage doesn't drag in the SAB.
    const bodyCopy = new Uint8Array(res.body.length);
    bodyCopy.set(res.body);
    post("log", { text: `[worker] dispatching response reqId=${res.reqId} status=${res.status} bytes=${bodyCopy.length} t=${nowMs().toFixed(2)}`, level: "info" });
    self.postMessage({
      kind: "page-edge-res",
      reqId: res.reqId,
      status: res.status,
      headers: res.headers,
      body: bodyCopy.buffer,
    }, [bodyCopy.buffer]);
  });
  shim.bus.setWakePoll(() => {
    // Drain the SAB inbox.  Multiple requests can be ready in the same
    // wake — push each to the bus.  Bus assigns a new socket fd per
    // request, so concurrent requests get independent connections.
    const reqs = drainBridgeRing(bridgeRing);
    for (const req of reqs) {
      post("log", { text: `[worker] drained req reqId=${req.reqId} t=${nowMs().toFixed(2)}`, level: "info" });
      shim.bus.pushRequest(req);
    }
  });
  // SAB doesn't survive MessagePort.postMessage to a Service Worker in
  // current Chrome; the message is silently dropped (verified — a plain
  // {kind:"ping"} on the same port arrives, a payload that includes a
  // SAB does not).  We relay through the page (main thread), which can
  // sw.postMessage() the SABs directly.
  self.postMessage({
    kind: "relay-bridge-sab",
    bridgeSab: bridgeRing.sab,
    wakeSab: shim.bus.wakeView.buffer,
  });
  post("log", { text: "[worker] relay-bridge-sab posted to page (SW-bound)", level: "info" });

  // If the page enabled memory-snapshot debugging for specific symbols,
  // wrap those namespaces so each call captures bytes around pointer args.
  // The wrapper stashes captures on `pendingMem`; the trace callback below
  // drains it on the matching call so we get one trace record per call.
  let wasiNs = memSnapshotSymbols.size > 0
    ? instrumentNamespace(shim.wasi_snapshot_preview1, "wasi_snapshot_preview1", memory,
        { ...DEFAULT_MEM_OPTIONS, enabledSymbols: memSnapshotSymbols })
    : shim.wasi_snapshot_preview1;
  let wasixNs = memSnapshotSymbols.size > 0
    ? instrumentNamespace(shim.wasix_32v1, "wasix_32v1", memory,
        { ...DEFAULT_MEM_OPTIONS, enabledSymbols: memSnapshotSymbols })
    : shim.wasix_32v1;
  if (memSnapshotSymbols.size > 0) {
    post("log", { text: `mem-snapshot enabled for: ${[...memSnapshotSymbols].join(", ")}`, level: "info" });
  }

  // #14 diagnostic: when watchByteLength is on, wrap the shim namespaces with
  // a byteLength/SAB-identity watcher.  Logs every change.  Helps test
  // Hypothesis B (memory.grow during bootstrap → stale buffer references).
  let blWatcher: ReturnType<typeof createByteLengthWatcher> | null = null;
  if (watchByteLength) {
    blWatcher = createByteLengthWatcher(memory);
    wasiNs = blWatcher.wrap(wasiNs, "wasi_snapshot_preview1");
    wasixNs = blWatcher.wrap(wasixNs, "wasix_32v1");
    post("log", { text: `byteLength watcher: armed on wasi/wasix namespaces`, level: "info" });
    post("log", { text: `byteLength initial: ${memory.buffer.byteLength}`, level: "info" });
  }

  // Edge's rebuilt wasm imports `unofficial_napi_*` under the
  // `napi_extension_wasmer_v0` module (per their `__import_module__`
  // attribute), not under `napi` like the older build did.  Our
  // napi-host still registers ALL napi_* impls in `napi.imports.napi`,
  // so split them across the two namespaces here.  Mirrors
  // scripts/node-harness.mjs.
  const napiAll = napi.imports.napi as Record<string, Function>;

  // ── B / scope-op forwarding ────────────────────────────────────
  //
  // Mirror wasm-side `napi_open_handle_scope` / `napi_close_handle_scope`
  // onto the host worker so handles allocated by host-RPC ops (the
  // F-9 family: OP_NAPI_CREATE_OBJECT etc.) don't accumulate in the
  // host's long-lived root scope.  See NOTES.md
  // `host-emnapi-root-scope-accumulates`.
  //
  // Map: wasm-side scope id (returned to the wasm caller via
  // napi_open_handle_scope's resultPtr) → host-side scope id (what
  // the OP_NAPI_OPEN_HANDLE_SCOPE reply carries).
  //
  // If hostRpcSyncClient isn't attached (e.g., bootstrap RPC SAB
  // hasn't been wired yet), we fall back silently to wasm-only — the
  // wasm-side scope still works; the host just accumulates (debt
  // continues until the next scope/close pair).  Same fallback for
  // missing scope id in close.
  {
    const wasmToHostScope = new Map<number, number>();
    const origOpen = napiAll["napi_open_handle_scope"];
    const origClose = napiAll["napi_close_handle_scope"];

    if (typeof origOpen === "function") {
      napiAll["napi_open_handle_scope"] = function (env: number, resultPtr: number): number {
        const status = (origOpen as (e: number, p: number) => number)(env, resultPtr);
        if (status !== 0) return status;
        if (!hostRpcSyncClient) return status; // bootstrap before RPC SAB
        // Read the wasm-side scope id emnapi just wrote at resultPtr.
        // The wasm Memory accessor is direct: emnapi writes into the
        // shared `memory.buffer` we passed to createNapiHost.
        try {
          const wasmScopeId = new DataView(memory.buffer).getUint32(resultPtr >>> 0, true);
          // Fire the host RPC.  Request: empty (host has only 1 env).
          // Reply: 4 bytes containing host scope id.
          const reply = hostRpcSyncClient.callSync(
            OP_NAPI_OPEN_HANDLE_SCOPE, hostWorkerId, 0, new Uint8Array(0),
          );
          if (reply.status === REPLY_STATUS_OK && reply.payload.byteLength >= 4) {
            const hostScopeId = new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength).getUint32(0, true);
            wasmToHostScope.set(wasmScopeId >>> 0, hostScopeId >>> 0);
          }
        } catch (e) {
          // Don't propagate RPC errors back to wasm — best-effort
          // forwarding.  The wasm side already has a valid scope.
          post("log", { text: `[scope-forwarding] open RPC failed: ${(e as Error).message}`, level: "warn" });
        }
        return status;
      };
    }

    if (typeof origClose === "function") {
      napiAll["napi_close_handle_scope"] = function (env: number, wasmScopeId: number): number {
        // Capture host scope id BEFORE calling close, in case the
        // implementation invalidates the wasm-side id at any point.
        const hostScopeId = wasmToHostScope.get(wasmScopeId >>> 0);
        wasmToHostScope.delete(wasmScopeId >>> 0);
        const status = (origClose as (e: number, s: number) => number)(env, wasmScopeId);
        if (hostScopeId === undefined || !hostRpcSyncClient) return status;
        try {
          const payload = new Uint8Array(4);
          new DataView(payload.buffer).setUint32(0, hostScopeId, true);
          hostRpcSyncClient.callSync(
            OP_NAPI_CLOSE_HANDLE_SCOPE, hostWorkerId, 0, payload,
          );
        } catch (e) {
          post("log", { text: `[scope-forwarding] close RPC failed: ${(e as Error).message}`, level: "warn" });
        }
        return status;
      };
    }
  }

  const napiStandard: Record<string, Function> = {};
  const napiExtension: Record<string, Function> = {};
  for (const k of Object.keys(napiAll)) {
    if (k.startsWith("unofficial_napi_")) napiExtension[k] = napiAll[k];
    else napiStandard[k] = napiAll[k];
  }

  // wasi-threads layer: real `wasi.thread-spawn` backed by a Worker pool.
  // Without this, edge.js's libuv thread spawn / OpenSSL / any C-side
  // pthread call shares TLS state (errno, __thread vars, OpenSSL per-thread
  // error stacks) across what should be separate threads.  See
  // architecture/worker-threads in NOTES.md.
  //
  // The shim returned by wasi-shim.ts has its own `thread-spawn` stub
  // returning -1.  We replace it with the ThreadManager's impl after
  // setup().  Pre-setup() calls (shouldn't happen during boot) keep the
  // stub.
  const wasiStub: WASIInstance = {
    wasiImport: undefined,
    initialize(_i: object) { void _i; },
    start(_i: object): number { void _i; return 0; },
    getImportObject(): { wasi: Record<string, Function> } { return { wasi: shim.wasi }; },
  };
  const wasiThreads = new WASIThreads({
    wasi: wasiStub,
    // CRITICAL for browsers: pre-spawn a pool so pthread_create doesn't
    // block on `Atomics.wait` for a worker that hasn't initialized yet.
    // Without `reuseWorker`, the main wasm thread calls wasi.thread-spawn
    // synchronously and waits for the new worker — but in a browser
    // DedicatedWorker context the worker can't initialize while we're
    // blocked in Atomics.wait.  Deadlock.
    //
    reuseWorker: { size: 4, strict: true },
    // Synchronous semantics: pthread_create returns only after the
    // thread actually started, matching real Node.  1000ms timeout
    // for safety; libuv expects sync creation.
    waitThreadStart: 1000,
    onCreateWorker: (_ctx) => {
      void _ctx;
      // Spawn the child-thread worker.  Vite imports it as a module worker.
      const childWorker = new Worker(new URL("./thread-worker.ts", import.meta.url), {
        type: "module",
        name: "edgejs-thread",
      });
      // Hand the pipe-registry + fs-snapshot SABs to the child
      // immediately so its wasi-shim can attach to the same
      // cross-thread state.  Post BEFORE emnapi's `load` message so
      // the child has the SABs stashed when it builds its shim.
      childWorker.postMessage({ kind: "edge-pipe-sab", sab: pipeRegistry.sharedBuffer });
      childWorker.postMessage({ kind: "edge-fs-snapshot-sab", sab: fsSnapshot.sharedBuffer });
      // Forward non-__emnapi__ messages (logs, debug breadcrumbs) from the
      // child to the page.  ThreadManager will attach its own listener for
      // __emnapi__-wrapped protocol messages; we co-exist on the same
      // worker via addEventListener (multiple message listeners allowed).
      childWorker.addEventListener("message", (e: MessageEvent) => {
        const data = e.data as { __emnapi__?: unknown; kind?: string; text?: string; level?: string } | null;
        if (!data || data.__emnapi__ !== undefined) return;
        if (data.kind === "thread-log") {
          post("log", { text: data.text ?? "", level: data.level ?? "info" });
        }
      });
      return childWorker;
    },
  });

  // Compose: emnapi's napi/env/emnapi + our wasi/wasix + wasi-threads.
  // The wasi-threads getImportObject() returns {wasi: {'thread-spawn': fn}}
  // which we merge OVER shim.wasi so the stub is replaced.
  const overrides = {
    napi: napiStandard,
    napi_extension_wasmer_v0: napiExtension,
    env: napi.imports.env as Record<string, Function>,
    wasi_snapshot_preview1: wasiNs,
    wasix_32v1: wasixNs,
    wasi: { ...shim.wasi, ...wasiThreads.getImportObject().wasi } as Record<string, Function>,
  };
  // Progress watchdog — abort wasm only if it's actually stuck.
  //
  // Old behavior was a flat CALL_LIMIT (100k wasi calls → abort) which
  // misfired the moment real workloads ran a few concurrent requests
  // (each easily emits 25k+ wasi calls).  New behavior: track
  // consecutive same-symbol calls.  A tight wasm loop spinning on
  // (say) clock_time_get manifests as 1000s of identical calls in a
  // row — that's what we catch.  Healthy traffic alternates between
  // many symbols (fd_read, poll_oneoff, clock_time_get, fd_write,
  // path_open, etc.) so the streak resets constantly.
  //
  // 200k threshold gives ~ms-scale slack on a 200ns/import budget;
  // misfires only on genuine spins.
  // Configurable spin threshold.  Page passes `?spinLimit=N` via the
  // start message; 0 disables entirely.  Default 2M (~tens of seconds
  // of real spin) is conservative — high enough that healthy traffic
  // doesn't trip even under load (typical bench saw 145+ dispatched
  // before the underlying clock_time_get spin pinned the counter),
  // low enough that genuinely stuck wasm aborts in a useful window.
  const SPIN_STREAK_LIMIT = spinStreakLimit;
  let lastSymKey = "";
  let consecutive = 0;
  const wasmImports = buildImports(memory, overrides, (ns, sym, args, ret, stub) => {
    // If the mem-snapshot wrapper just ran on this call, it left snapshots
    // on the side channel.  Pick them up and attach to this canonical record.
    const mem = pendingMem.value;
    if (mem) pendingMem.value = null;
    trace.record(ns, sym, args, ret, stub, mem ?? undefined);
    const key = ns + "." + sym;
    if (key === lastSymKey) {
      if (SPIN_STREAK_LIMIT > 0 && ++consecutive >= SPIN_STREAK_LIMIT) {
        throw new Error(`spin detected: ${SPIN_STREAK_LIMIT} consecutive ${key} calls — wasm is making no progress`);
      }
    } else {
      consecutive = 0;
      lastSymKey = key;
    }
    // Reset the clock_time_get-specific streak when any other wasi
    // import fires — the spin probe in clock_time_get tracks runs of
    // pure clock_time_get calls (no other wasi activity).
    if (key !== "wasi_snapshot_preview1.clock_time_get") {
      const cp = (globalThis as { __edgeClockProbe?: { streak: number; logged: boolean } }).__edgeClockProbe;
      if (cp) cp.streak = 0;
    }
  });

  // emnapi puts its own env.memory; make sure it's the one we want.
  (wasmImports.env as Record<string, unknown>).memory = memory;

  const t0 = nowMs();
  let module: WebAssembly.Module;
  if (sharedWasmModule) {
    module = sharedWasmModule;
  } else {
    if (!wasmBytes) {
      post("log", { text: "FATAL: neither sharedWasmModule nor wasmBytes available", level: "err" });
      return;
    }
    module = await WebAssembly.compile(wasmBytes);
    post("log", { text: `compiled in ${(nowMs() - t0).toFixed(0)} ms`, level: "info" });
  }

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, wasmImports);
  } catch (e) {
    post("log", { text: `INSTANTIATE FAILED: ${(e as Error).message}`, level: "err" });
    return;
  }
  post("log", { text: "instantiated; binding emnapi to instance…", level: "info" });

  try {
    napi.bindInstance(instance, module);
    post("log", { text: "emnapi bound; running _start…", level: "info" });
  } catch (e) {
    post("log", { text: `emnapi.bindInstance threw: ${(e as Error).message}`, level: "err" });
    // Continue anyway — see what _start does with whatever state we have.
  }

  // F-9 path-a: register the reverse-RPC callback invoker.  When the
  // host's emnapi creates a JS function from a wasm-side funcref
  // (napi_create_function etc.), the JS function's body sends
  // OP_INVOKE_WASM_CALLBACK back to this worker via the reverse
  // channel; we look up the funcref in __indirect_function_table and
  // invoke it.  See callback-dispatch.ts + CALLBACK-DISPATCH-SPEC.md.
  //
  // R7 wiring (cbinfo synthesis): pass the wasm-side emnapi Context
  // + an accessor for the active Env.  The dispatcher uses these
  // to synthesize `napi_callback_info` per the NAPI_CALLBACK shape.
  // The env accessor is lazy because envs are created during _start
  // (after this registration point) by `unofficial_napi_create_env`.
  if (reverseRpcServer) {
    try {
      const wasmTable = instance.exports.__indirect_function_table as WebAssembly.Table | undefined;
      if (wasmTable) {
        const depthCounter = createCallbackDepthCounter();
        registerWasmCallbackInvoker(reverseRpcServer, {
          wasmTable,
          depthCounter,
          wasmCtx: napi.context,
          wasmEnv: () => {
            const it = napi.envs.values().next();
            return it.done ? undefined : it.value;
          },
        });
        post("log", { text: "[runtime] OP_INVOKE_WASM_CALLBACK handler registered", level: "info" });
      } else {
        post("log", { text: "[runtime] no __indirect_function_table on wasm instance; callback invoker not registered", level: "warn" });
      }
    } catch (e) {
      post("log", { text: `[runtime] registerWasmCallbackInvoker failed: ${(e as Error).message}`, level: "err" });
    }
  }

  // wasi-threads setup.  ThreadManager reads `instance.exports.malloc`
  // and `.free` directly when allocating thread arg slots.  Edge.js's
  // wasm exports them as `unofficial_napi_guest_malloc` /
  // `unofficial_napi_guest_free` (per WASIX naming).  Hand wasi-threads
  // a Proxy that aliases those to the names it expects.
  const threadInstanceProxy = new Proxy(instance, {
    get(target, key) {
      if (key === "exports") {
        const orig = target.exports as Record<string, unknown>;
        return new Proxy(orig, {
          get(t, k) {
            if (k === "malloc") return t["unofficial_napi_guest_malloc"] ?? t["malloc"];
            if (k === "free") return t["unofficial_napi_guest_free"] ?? t["free"] ?? (() => { /* leak */ });
            return Reflect.get(t, k);
          },
          has(t, k) {
            if (k === "malloc" || k === "free") return true;
            return Reflect.has(t, k);
          },
        });
      }
      return Reflect.get(target, key);
    },
  });
  try {
    wasiThreads.setup(threadInstanceProxy, module, memory);
    await wasiThreads.preloadWorkers();
    post("log", { text: "wasi-threads: ready to spawn (TLS-isolated child workers, pool preloaded)", level: "info" });
  } catch (e) {
    post("log", { text: `wasi-threads.setup threw: ${(e as Error).message}`, level: "warn" });
  }

  const start = (instance.exports as { _start?: () => void })._start;
  if (!start) { post("log", { text: "no _start export", level: "err" }); return; }

  // Under JSPI, entryPointWrapper turns _start into a Promise-returning
  // function so Suspending-wrapped imports (timer-only poll_oneoff) can
  // suspend the wasm without blocking the worker's event loop —
  // host microtasks (fetch, CompressionStream, etc.) drain during the
  // suspend window.  Under sync strategy, identity (sync call as before).
  const startFn = entryPointWrapper(start);
  let exitCode: number | null = null;
  let threwMsg: string | null = null;
  const tStart = nowMs();
  // Track depth of the promising-wrapped activation so Suspending
  // imports can detect when they're being called from a JS-driven
  // re-entry (depth=0) vs from inside _start (depth>0).  Re-entries
  // can't suspend (no promising frame on the current call stack), so
  // the Suspending impls do a sync Atomics.wait instead of returning
  // a Promise in that case.  See pollOneoffAsyncImpl / futexWaitAsyncImpl.
  type DepthHolder = { __edgePromisingDepth?: number };
  const dh = globalThis as DepthHolder;
  dh.__edgePromisingDepth = (dh.__edgePromisingDepth ?? 0) + 1;
  try { await startFn(); }
  catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else threwMsg = (e as Error).stack ?? String(e);
  }
  finally { dh.__edgePromisingDepth = (dh.__edgePromisingDepth ?? 1) - 1; }
  const runMs = nowMs() - tStart;

  post("log", {
    text: `_start ran ${runMs.toFixed(0)} ms ` +
      (exitCode !== null ? `(exit=${exitCode})` : threwMsg ? `(THREW)` : "(returned)"),
    level: exitCode === 0 ? "info" : exitCode !== null ? "err" : threwMsg ? "err" : "info",
  });

  // Worker-threads phase 1: if this is a child user-worker, notify main
  // so it can forward the exit event to the parent's host worker (which
  // fires OP_DELIVER_USER_WORKER_EXIT into parent's wasm).  Main also
  // terminates this child's host + wasm workers after forwarding.
  if (userWorkerMode) {
    // If _start threw without an ExitSignal, use 1 (Node convention for
    // uncaught exceptions).  If it returned cleanly without proc_exit,
    // use 0.
    const effectiveCode = exitCode ?? (threwMsg ? 1 : 0);
    // Phase 3c (e33+): if the child threw an uncaught exception, also
    // pack the error info so the parent can emit a Node-spec
    // 'error' event on the Worker BEFORE the 'exit' event.  Pre-fix
    // behavior: only 'exit' fired (with non-zero code), no 'error',
    // so user error handlers never ran.  Pack via packPostMessage so
    // the same cross-context-marshal handles all the Error fields
    // (name/message/stack/etc).  Empty/null when no throw.
    let errorBytes: Uint8Array | null = null;
    if (threwMsg !== null) {
      try {
        const errPayload = {
          name: "Error",
          message: threwMsg.split("\n")[0] || "uncaught exception",
          stack: threwMsg,
        };
        errorBytes = packPostMessage(errPayload);
      } catch (e) { void e; }
    }
    self.postMessage({
      kind: "user-worker-exit",
      workerId: userWorkerMode.workerId,
      exitCode: effectiveCode,
      errorBytes,
    });
  }
  if (blWatcher) {
    const events = blWatcher.drain();
    post("log", { text: `byteLength events: ${events.length}`, level: "info" });
    for (const line of formatBlEvents(events).slice(0, 50)) {
      post("log", { text: line, level: "info" });
    }
    post("log", {
      text: `byteLength final: ${memory.buffer.byteLength} (initial 22085632)`,
      level: "info",
    });
  }

  const summary: string[] = [];
  summary.push(`total calls: ${trace.all().length}`);
  summary.push("by namespace:");
  for (const [ns, s] of trace.byNamespace()) {
    summary.push(`  ${ns.padEnd(28)} total=${String(s.total).padStart(5)}  distinct=${s.distinct}`);
  }
  summary.push("ALL distinct calls (by count):");
  for (const s of trace.topByCount(100)) {
    const flag = s.stub ? "STUB" : "impl";
    summary.push(`  [${flag}]  ${String(s.count).padStart(5)}  ${s.ns}.${s.sym}`);
  }
  // Errno-proxy: every non-zero return from wasi/wasix sets libc's errno.
  // Listing them in order shows what errno value the wasm last saw before
  // any failure.  Filter out napi (return semantics differ — 0 is OK there too).
  summary.push("");
  summary.push("non-zero wasi/wasix returns (errno proxy):");
  const errnoEvents = trace.all().filter((r) =>
    (r.ns === "wasi_snapshot_preview1" || r.ns === "wasix_32v1" || r.ns === "wasi") &&
    typeof r.ret === "number" && r.ret !== 0,
  );
  if (errnoEvents.length === 0) {
    summary.push("  (none — every wasi syscall succeeded)");
  } else {
    for (const r of errnoEvents.slice(-20)) {
      summary.push(`  ${r.t.toFixed(1).padStart(7)}ms  ${r.ns}.${r.sym}(${r.args.map((a) => JSON.stringify(a)).join(", ")}) -> errno=${r.ret}`);
    }
  }
  summary.push("last 30 calls (closest to exit):");
  for (const r of trace.tail(30)) {
    const flag = r.stub ? "STUB" : "impl";
    const ret = typeof r.ret === "string" ? r.ret : JSON.stringify(r.ret);
    summary.push(`  ${r.t.toFixed(1).padStart(7)}ms  [${flag}]  ${r.ns}.${r.sym}(${r.args.map((a) => JSON.stringify(a)).join(", ")}) -> ${ret}`);
  }
  if (threwMsg) {
    summary.push("");
    summary.push("--- threw ---");
    summary.push(threwMsg.split("\n").slice(0, 8).join("\n"));
  }
  post("log", { text: "\n" + summary.join("\n"), level: "info" });

  const json = JSON.stringify({ exitCode, threw: threwMsg, runMs, summary: trace.summarize(), tail: trace.tail(200), all: trace.all() }, null, 2);
  const jsonl = toUnifiedJsonl(trace);
  post("report", { json, jsonl });
}

function runDiagnostics() {
  post("section", { text: "── #14 diagnostic: SAB view aliasing (Hypothesis A) ──" });
  try {
    const reports = runSabViewAliasingDiagnostic();
    for (const line of formatSabReport(reports)) {
      post("log", { text: line, level: "info" });
    }
  } catch (e) {
    post("log", { text: `diagnostic threw: ${(e as Error).stack ?? e}`, level: "err" });
  }
}

async function boot() {
  try {
    if (runDiagnosticsFirst) {
      runDiagnostics();
      post("status", { text: "diagnostic complete" });
      return;
    }
    await runHelloSmokeTest();
    await runEdgeWithEmnapi();
    post("status", { text: "done" });
  } catch (err) {
    post("log", { text: `FATAL: ${(err as Error).stack ?? err}`, level: "err" });
    post("status", { text: "crashed" });
  }
}

// Worker boot accepts a config payload so the page can pass URL-param-style
// options (e.g. memory snapshot symbols to instrument).
let memSnapshotSymbols: Set<string> = new Set();
let runDiagnosticsFirst = false;
let watchByteLength = false;
let userScript: string | null = null;
// Spin watchdog threshold — page can override via ?spinLimit=N (0
// disables).  Default 2M means "if 2 million consecutive identical
// wasi imports fire, abort."  Real workloads on healthy traffic
// shouldn't get anywhere near this; only genuine tight loops will.
let spinStreakLimit = 2_000_000;
// `?trace=0` from page disables per-call trace recording — saves the
// args/return object allocation on every wasi import.  Real perf win
// for steady-state traffic.
let traceDisabled = false;
// Comma-separated policy names from `?policies=` URL param.  Appended
// to defaultBrowserPolicies.
let extraPolicyNames: string[] = [];

// HTTP bridge: requests come in via a SharedArrayBuffer the page writes
// directly into.  This is the only way to get data through to the worker
// while the wasm has it stuck inside Atomics.wait — a MessagePort message
// would queue but never get drained until the worker yields back to its
// event loop, which doesn't happen during a sync wasm call.
//
// The bridge SAB is now a sab-ring instance (16 slots × 32KB) — see
// `wasi-shim/bridge-sab.ts` for the wire format and wake protocol.
// Responses still go back via self.postMessage (page-edge-res) keyed
// by reqId; the SW already maps reqId → pending promise.
const bridgeRing = createBridgeRing();

function onBridgeMessage(_e: MessageEvent) {
  // Legacy MessagePort path — kept as a no-op for compatibility with the
  // earlier scaffold.  The SW now writes requests directly into bridgeSab;
  // this handler only fires for protocol messages we don't use yet.
  // (Responses go SW-bound via bridgePort.postMessage, so the SW does
  // listen to the port — but the WORKER does not need to receive port
  // messages for the request path.)
}

self.onmessage = (e) => {
  if (e.data?.kind === "bridge-port" && e.data.port instanceof MessagePort) {
    const port = e.data.port as MessagePort;
    port.onmessage = onBridgeMessage;
    port.start();
    return;
  }
  // Worker-threads phase 1: user-worker bootstrap (acts as `start` for
  // child runtimes spawned via `new Worker(filename)`).  Carries a
  // pre-compiled WebAssembly.Module (E24 mandate, ~22 ms compile time
  // savings per child) plus the srcPath the child should require after
  // edge.js boots.  We synthesize a userScript that requires the
  // srcPath, treat it as if `start` had arrived, then call boot().
  if (e.data?.kind === "edge-user-worker-bootstrap") {
    const { workerId, bootstrapScript, workerData, sharedWasmModule: mod, extraPolicies: childPolicies } = e.data as {
      workerId: number;
      bootstrapScript: string;
      workerData?: Uint8Array;
      sharedWasmModule?: WebAssembly.Module;
      extraPolicies?: string[];
    };
    if (typeof bootstrapScript !== "string" || typeof workerId !== "number") {
      post("log", { text: "[runtime] edge-user-worker-bootstrap: missing bootstrapScript or workerId", level: "err" });
      return;
    }
    if (mod) sharedWasmModule = mod;
    // Followup e33: inherit parent's `?policies=...` so the same policy
    // patches (e.g. worker-threads-per-thread for port-transfer infra)
    // are active on the child.  Was previously a silent gap — children
    // booted with only defaultBrowserPolicies regardless of the parent
    // page's URL params.
    if (Array.isArray(childPolicies)) {
      extraPolicyNames = childPolicies.filter((s: unknown): s is string => typeof s === "string");
    }
    userWorkerMode = {
      workerId,
      bootstrapScript,
      workerData: workerData ?? new Uint8Array(0),
    };
    // Phase 2: surface user-worker mode + workerData bytes on globalThis
    // BEFORE boot() runs lib JS.  The worker-threads-per-thread policy
    // patch reads __edgeIsUserWorker to know whether to install the
    // parentPort export on lib/worker_threads.js; it reads
    // __edgeUserWorkerDataBytes to unmarshal the workerData JS value
    // exposed alongside parentPort.
    (globalThis as { __edgeIsUserWorker?: boolean }).__edgeIsUserWorker = true;
    (globalThis as { __edgeUserWorkerDataBytes?: Uint8Array }).__edgeUserWorkerDataBytes =
      userWorkerMode.workerData;
    // The user script runs verbatim in edge.js's lib environment.  The
    // policy patch (worker-threads-per-thread.ts) constructs this for
    // file mode (= `require(<path>)`) or eval mode (= the code itself).
    userScript = bootstrapScript;
    boot();
    return;
  }
  if (e.data?.kind === "start") {
    if (Array.isArray(e.data.memSnapshotSymbols)) {
      memSnapshotSymbols = new Set(e.data.memSnapshotSymbols);
    }
    if (e.data.diagnoseSabAliasing === true) {
      runDiagnosticsFirst = true;
    }
    if (e.data.watchByteLength === true) {
      watchByteLength = true;
    }
    if (typeof e.data.userScript === "string" && e.data.userScript.length > 0) {
      userScript = e.data.userScript;
    }
    if (typeof e.data.spinLimit === "number" && e.data.spinLimit >= 0) {
      spinStreakLimit = e.data.spinLimit;
    }
    if (e.data.traceDisabled === true) {
      traceDisabled = true;
    }
    if (Array.isArray(e.data.extraPolicies)) {
      extraPolicyNames = e.data.extraPolicies.filter((s: unknown): s is string => typeof s === "string");
    }
    boot();
  }
};
