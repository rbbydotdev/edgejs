// Public surface of the napi host.
//
// `createNapiHost` returns:
//   - `imports`: a Record<string, Record<string, Function>> ready to compose
//     into the wasm imports object.  Contains the `napi`, `env`, and `emnapi`
//     module namespaces emnapi expects.
//   - `bindInstance(instance)`: call after `WebAssembly.instantiate` resolves;
//     this triggers emnapi's `init` flow against a proxy that satisfies its
//     malloc/free/register expectations, and locks in wasmMemory/wasmTable.
//
// Composition order matters: the WASIX shim namespaces (`wasi_*`, `wasix_*`,
// orphan `wasi`) must be merged in by the caller AFTER calling `imports`,
// since this module knows nothing about WASI.

// Install globalThis.Buffer BEFORE @emnapi/* imports — emnapi captures
// `_Buffer` at module evaluation; if Buffer isn't a function then,
// napi_create_buffer_copy throws NotSupportBufferError forever.
import "../host/globals-shim";

import {
  createContext,
  createNapiModule,
  v8Plugin,
  asyncWorkPlugin,
  tsfnPlugin,
  type Context,
  type Env,
  type NapiModule,
} from "./emnapi";
import { createInstanceProxy } from "./instance-proxy";
import { createUnofficialNapi } from "./unofficial";
import { buildMicrotaskOpsImports, createMicrotaskOpsState, installHostPromiseRejectListeners, type MicrotaskOpsState } from "./microtask-ops";
import { createUvAsyncRuntime, type UvAsyncRuntimeWithSize } from "./uv-async";
import type { ModuleOverride } from "../policies";
export type { ModuleOverride };
export type { Context, Env } from "./emnapi";

export interface NapiHostOptions {
  memory: WebAssembly.Memory;
  /** Optional filename for diagnostics; surfaces in stack traces from the env. */
  filename?: string;
  /**
   * Override the source for edge.js built-in modules (`crypto`, `inspector`,
   * `fs`, etc.) before they're compiled.  Keys can be `node:<id>` (the
   * full filename edge uses) or bare specifier (`<id>`).
   *
   * Value shapes:
   * - `string` → replace module body entirely with this source.
   * - `null` → empty stub (`module.exports = {}`).
   * - `{ post: string }` → keep edge's bundled body, append `post` source
   *   AFTER it (inside the same function wrapper).  Use this for surgical
   *   patches that need access to module locals + module.exports.
   * - `undefined` → no override; use edge's bundled source.
   *
   * This intercepts edge's `BuiltinsCompileFunctionCallback` →
   * `unofficial_napi_contextify_compile_function` path (bootstrap modules)
   * AND the `napi_run_script` path (lazy-required builtins).
   */
  builtinOverrides?: Record<string, ModuleOverride | undefined>;
  /** Optional debug sink for host-side breadcrumbs (compile filenames,
   * override matches).  Routed to the same channel as the worker's
   * postLog so output is visible in both Node-harness and browser. */
  postLog?: (line: string, level: "out" | "warn" | "err" | "debug") => void;
  /** E9: Holder for the wasi-shim's `requestExit` callback.  When the wasm
   *  calls `unofficial_napi_terminate_execution` (because JS-side
   *  `process.exit()` ran), we route into this so the shim's parked
   *  `poll_oneoff` can abort.  Holder pattern because the napi-host is
   *  created BEFORE the wasi-shim in `worker.ts` — wire the `fn` after
   *  both are built (`holder.fn = shim.requestExit`).  See
   *  experiments/e9-process-exit-in-fr/FINDINGS.md. */
  requestExitHolder?: { fn?: (code: number) => void };
}

export interface NapiHost {
  /** The full set of import namespaces this host satisfies: `napi`, `env`, `emnapi`. */
  imports: Record<string, Record<string, Function | WebAssembly.Memory>>;
  /** Call once after `WebAssembly.instantiate` — primes emnapi's internal state. */
  bindInstance(realInstance: WebAssembly.Instance, wasmModule: WebAssembly.Module): void;
  /** Direct access to the emnapi Context (for debugging / probing). */
  context: Context;
  /** Envs created via `unofficial_napi_create_env`, keyed by env ID. */
  envs: Map<number, Env>;
}

/** Property-descriptor layout per emnapi-core (napi_define_class), 32 bytes:
 *   off  0..3   utf8Name   (pointer)
 *   off  4..7   name       (napi_value handle)
 *   off  8..11  method     (function pointer)
 *   off 12..15  getter     (function pointer)
 *   off 16..19  setter     (function pointer)
 *   off 20..23  value      (napi_value handle)
 *   off 24..27  attributes (u32 bitmask)
 *   off 28..31  data       (pointer)
 */
const PROP_DESC_STRIDE = 32;
const PROP_DESC_OFF_METHOD = 8;
const PROP_DESC_OFF_GETTER = 12;
const PROP_DESC_OFF_SETTER = 16;
const PROP_DESC_OFF_VALUE = 20;
const EMNAPI_GLOBAL_HANDLE_UNDEFINED = 1;

function patchEmnapiDefineForEmptyValue(
  napiModule: NapiModule,
  memory: WebAssembly.Memory,
): void {
  const napiNs = napiModule.imports.napi as Record<string, Function>;
  // Fast pass over the descriptor array: any descriptor where the four
  // "what is this property?" slots (method/getter/setter/value) are ALL
  // zero gets its `value` field bumped to 1 (= GlobalHandle.UNDEFINED).
  // That hits emnapi's else-branch with a resolvable handle.
  function rewriteEmptyValues(propsPtr: number, propCount: number): void {
    if (propCount <= 0 || propsPtr === 0) return;
    const dv = new DataView(memory.buffer);
    for (let i = 0; i < propCount; i++) {
      const base = propsPtr + i * PROP_DESC_STRIDE;
      const method = dv.getUint32(base + PROP_DESC_OFF_METHOD, true);
      const getter = dv.getUint32(base + PROP_DESC_OFF_GETTER, true);
      const setter = dv.getUint32(base + PROP_DESC_OFF_SETTER, true);
      const value = dv.getUint32(base + PROP_DESC_OFF_VALUE, true);
      if (method === 0 && getter === 0 && setter === 0 && value === 0) {
        dv.setUint32(base + PROP_DESC_OFF_VALUE, EMNAPI_GLOBAL_HANDLE_UNDEFINED, true);
      }
    }
  }

  const origDefineClass = napiNs.napi_define_class;
  const origDefineProperties = napiNs.napi_define_properties;
  if (typeof origDefineClass === "function") {
    napiNs.napi_define_class = (
      env: number, utf8name: number, length: number, ctor: number,
      cbData: number, propCount: number, properties: number, result: number,
    ) => {
      rewriteEmptyValues(properties, propCount);
      return origDefineClass(env, utf8name, length, ctor, cbData, propCount, properties, result);
    };
  }
  if (typeof origDefineProperties === "function") {
    napiNs.napi_define_properties = (
      env: number, obj: number, propCount: number, properties: number,
    ) => {
      rewriteEmptyValues(properties, propCount);
      return origDefineProperties(env, obj, propCount, properties);
    };
  }
}

// Sync the wasm-side mirror after emnapi creates a Buffer.
//
// emnapi's `napi_create_buffer_copy(env, length, data, result_data, result)`:
//   1. Allocates a fresh JS ArrayBuffer of `length` bytes (all zero).
//   2. Calls `getArrayBufferPointer(arrayBuffer, true)` which `_malloc`s
//      `length` bytes in WASM linear memory and copies the (empty) ArrayBuffer
//      bytes into wasm[P..P+length].  Writes the wasm address P to `*result_data`.
//   3. Wraps the JS ArrayBuffer in a polyfill Buffer.
//   4. `buffer.set(wasmMemory[data..data+length])` copies the SOURCE bytes
//      into the JS Buffer — but NOT into wasm[P..P+length] (the mirror).
//
// Override emnapi's Buffer constructors to allocate from WASM linear memory
// directly, eliminating the JS-ArrayBuffer-with-wasm-mirror split.
//
// Why this matters: emnapi's default `napi_create_buffer_copy` creates a fresh
// JS ArrayBuffer in JS land and a wasm-memory mirror separately.  The two are
// synced JS→wasm only at certain napi boundaries (with shouldCopy=true).  Edge's
// C++ Buffer accessors (`hexSlice`, `utf8Slice`, `compare`, etc. via
// `internalBinding('buffer')`) read from the wasm mirror.  When edge wraps the
// buffer in a view with non-zero byteOffset (its Buffer pool pattern),
// emnapi returns `mirror_addr + view.byteOffset` — which reads past the
// malloc'd mirror region into uninitialized heap.  Hence the famous
// "createHash().digest('hex') returns JavaScript source bytes" bug.
//
// Fix: allocate the Buffer's storage IN WASM MEMORY via the wasm's exported
// `malloc`, then create the Buffer as `Buffer.from(wasmMemory.buffer, ptr, len)`.
// The resulting Buffer's `.buffer === wasmMemory.buffer` and `.byteOffset === ptr`.
// emnapi's `getViewPointer` short-circuits to `return { address: view.byteOffset }`
// — no mirror, no sync, JS and wasm share storage byte-for-byte.
//
// This is the architecturally correct fix for the emnapi ↔ edge Buffer
// model mismatch.  See NOTES.md 2026-05-21 "Crypto digest correctness" for
// the full diagnosis.
//
// REQUIRES: the wasm instance must have bound by the time these overrides are
// called (so the exported malloc is available).  See `bindInstance` below —
// it installs the malloc getter after init.
function patchEmnapiToUseWasmBackedBuffers(
  napiModule: NapiModule,
  memory: WebAssembly.Memory,
  context: Context,
  getMalloc: () => ((n: number) => number) | null,
): void {
  const napiNs = napiModule.imports.napi as Record<string, Function>;
  const origCreateBuffer = napiNs.napi_create_buffer;
  const origCreateBufferCopy = napiNs.napi_create_buffer_copy;
  const origCreateArrayBuffer = napiNs.napi_create_arraybuffer;
  const origCreateExternalArrayBuffer = napiNs.napi_create_external_arraybuffer;
  const origCreateTypedArray = napiNs.napi_create_typedarray;
  const origGetArrayBufferInfo = napiNs.napi_get_arraybuffer_info;
  const origGetTypedArrayInfo = napiNs.napi_get_typedarray_info;
  const origGetBufferInfo = napiNs.napi_get_buffer_info;
  const origIsArrayBuffer = napiNs.napi_is_arraybuffer;
  const origAddFinalizer = napiNs.napi_add_finalizer;

  // Tracks our wasm-backed "ArrayBuffer" handles.  These are Uint8Array
  // views (NOT real ArrayBuffer instances), but we present them to wasm
  // callers via napi as if they were arraybuffers.  The downstream
  // napi calls (`napi_create_typedarray`, `napi_get_arraybuffer_info`,
  // `napi_is_arraybuffer`) check this map and bypass emnapi's
  // `value instanceof ArrayBuffer` check for our handles.
  const wasmBackedABs = new Map<number, { ptr: number; length: number }>();

  // emnapi exposes its memory-sync primitive via napiModule.emnapi.syncMemory.
  // Call signature: (js_to_wasm: boolean, view: TypedArray|ArrayBuffer, offset, len) → value.
  // js_to_wasm=false copies wasm → JS, which is the direction we need for
  // edge.js's wasm-source-of-truth Buffer model.
  const emnapiNs = (napiModule as unknown as { emnapi: { syncMemory?: (js_to_wasm: boolean, view: unknown, offset: number, len: number) => unknown } }).emnapi;
  function syncWasmToJs(handleId: number): void {
    if (!emnapiNs?.syncMemory) return;
    const value = context.jsValueFromNapiValue(handleId);
    if (!value || typeof (value as { byteLength?: number }).byteLength !== "number") return;
    try {
      emnapiNs.syncMemory(false, value, 0, (value as { byteLength: number }).byteLength);
    } catch { /* sync errors are non-fatal */ }
  }

  function allocWasmBuffer(byteLength: number): { ptr: number; view: Uint8Array } | null {
    const malloc = getMalloc();
    if (!malloc) return null;
    const ptr = malloc(byteLength);
    if (!ptr) return null;
    // Construct the wasm-backed view directly via Uint8Array — NOT via
    // globalThis.Buffer.from, which is edge.js's Buffer class once
    // bootstrap has loaded it.  Edge's Buffer.from may have semantics
    // that don't match our needs (e.g. it might COPY when given an
    // ArrayBuffer + offset + length, depending on its implementation
    // path).  Using the raw Uint8Array constructor guarantees a view,
    // not a copy.  emnapi's `getViewPointer` will accept any
    // Uint8Array — what matters is view.buffer === wasmMemory.buffer.
    const view = new Uint8Array(memory.buffer, ptr, byteLength);
    return { ptr, view };
  }

  if (typeof origCreateBuffer === "function") {
    // napi_create_buffer(env, length, data_out, result) — caller writes data
    // INTO `*data_out` (the wasm address).  We allocate wasm memory, create a
    // wasm-backed Buffer view over that region, register the handle.
    napiNs.napi_create_buffer = (env: number, length: number, data_out: number, result: number) => {
      const allocd = allocWasmBuffer(length);
      if (!allocd) return origCreateBuffer(env, length, data_out, result);  // malloc not ready
      const dv = new DataView(memory.buffer);
      if (data_out > 0) dv.setUint32(data_out, allocd.ptr, true);
      const handle = context.napiValueFromJsValue(allocd.view);
      if (result > 0) dv.setUint32(result, Number(handle), true);
      void env;
      return 0; // napi_ok
    };
  }


  // Override napi_create_arraybuffer to return a wasm-backed view as the
  // "ArrayBuffer" handle.  Coordinated with napi_create_typedarray,
  // napi_get_arraybuffer_info, and napi_is_arraybuffer below — those
  // check `wasmBackedABs.has(handleId)` and route around emnapi's
  // `value instanceof ArrayBuffer` checks for our handles.
  //
  // Result: typed arrays created over our "ArrayBuffer" are
  // `new T(wasmMemory.buffer, ptr + byteOffset, length)` — wasm-source-of-truth.
  // JS-side reads (`view[i]`) and edge's C++ reads (via wasm pointer) see the
  // same bytes immediately, no mirror, no sync.
  if (typeof origCreateArrayBuffer === "function") {
    napiNs.napi_create_arraybuffer = (env: number, byte_length: number, data_out: number, result: number) => {
      const malloc = getMalloc();
      if (!malloc) return origCreateArrayBuffer(env, byte_length, data_out, result);
      const ptr = malloc(byte_length);
      if (!ptr) return origCreateArrayBuffer(env, byte_length, data_out, result);
      // Our "ArrayBuffer" handle is actually a Uint8Array view over wasm memory.
      // emnapi's type checks would fail, but our overrides below recognize it.
      const view = new Uint8Array(memory.buffer, ptr, byte_length);
      const handle = context.napiValueFromJsValue(view);
      wasmBackedABs.set(Number(handle), { ptr, length: byte_length });
      const dv = new DataView(memory.buffer);
      if (data_out > 0) dv.setUint32(data_out, ptr, true);
      if (result > 0) dv.setUint32(result, Number(handle), true);
      void env;
      return 0;
    };
  }

  // Override napi_create_external_arraybuffer.  Edge calls this from
  // `BindingCreateUnsafeArrayBuffer` (src/edge_buffer.cc:1132) and from
  // stream / udp wrap paths — every time, `external_data` is a wasm-side
  // pointer the caller has already malloc'd, and `byte_length` is the
  // region size.  Default emnapi creates a JS-heap `new ArrayBuffer(N)` and
  // remembers the mapping in `emnapiExternalMemory.table`, which forces
  // every read to sync wasm↔JS through napi entry points and leaves JS-side
  // indexed access STALE after C++ writes (see NOTES.md #!~debt
  // `buffer-write-jsab-stale`).
  //
  // Fix: register the handle's value as a Uint8Array view OVER wasm memory
  // at (external_data, byte_length).  JS and wasm now share the SAME bytes
  // — `view[i]` and the C++ pointer read/write the same memory cells.  No
  // sync, no mirror, no divergence.
  //
  // CONSUMER COMPATIBILITY: lib's `createUnsafeBuffer` does
  // `new FastBuffer(createUnsafeArrayBuffer(size))`.  Default behavior:
  // `new Uint8Array(arrayBuffer)` views; `new Uint8Array(typedArray)` COPIES.
  // With our override returning a Uint8Array view, lib would copy — defeating
  // the fix.  The `buffer-wasm-aliased` policy supplies a `{ post }` patch
  // for `internal/buffer` that rewrites `createUnsafeBuffer` to detect a
  // typed-array result and construct the FastBuffer via the 3-arg
  // `(buffer, byteOffset, byteLength)` form to keep it a view.  Apply this
  // policy together with this napi override or the wins are lost.
  if (typeof origCreateExternalArrayBuffer === "function") {
    napiNs.napi_create_external_arraybuffer = (
      env: number, external_data: number, byte_length: number,
      finalize_cb: number, finalize_hint: number, result: number,
    ) => {
      // 0-byte external AB: emnapi has special MessageChannel posting logic;
      // delegate so we don't break that subtle path.
      if (byte_length === 0 || external_data === 0) {
        return origCreateExternalArrayBuffer(env, external_data, byte_length, finalize_cb, finalize_hint, result);
      }
      const view = new Uint8Array(memory.buffer, external_data, byte_length);
      const handle = context.napiValueFromJsValue(view);
      wasmBackedABs.set(Number(handle), { ptr: external_data, length: byte_length });
      const dv = new DataView(memory.buffer);
      if (result > 0) dv.setUint32(result, Number(handle), true);
      // Mirror emnapi's finalizer convention: caller passes (finalize_data =
      // external_data) and the C++ finalizer frees that pointer when JS GCs
      // the wrapper.  napi_add_finalizer registers via the existing
      // emnapi finalizer machinery — no special handling needed.
      if (finalize_cb && typeof origAddFinalizer === "function") {
        origAddFinalizer(env, Number(handle), external_data, finalize_cb, finalize_hint, 0);
      }
      return 0; // napi_ok
    };
  }

  // napi_create_typedarray on our wasm-backed AB → create the typed array
  // directly over wasm memory at (ptr + byteOffset), bypassing emnapi's
  // `isArrayBuffer()` check.  For non-wasm-backed ABs, delegate.
  if (typeof origCreateTypedArray === "function") {
    napiNs.napi_create_typedarray = (
      env: number, type: number, length: number, ab_handle: number, byte_offset: number, result: number,
    ) => {
      const wab = wasmBackedABs.get(ab_handle);
      if (!wab) return origCreateTypedArray(env, type, length, ab_handle, byte_offset, result);
      const ctors: Array<{ Ctor: new (b: ArrayBufferLike, o: number, l: number) => ArrayBufferView; size: number }> = [
        { Ctor: Int8Array, size: 1 },              // 0
        { Ctor: Uint8Array, size: 1 },             // 1
        { Ctor: Uint8ClampedArray, size: 1 },      // 2
        { Ctor: Int16Array, size: 2 },             // 3
        { Ctor: Uint16Array, size: 2 },            // 4
        { Ctor: Int32Array, size: 4 },             // 5
        { Ctor: Uint32Array, size: 4 },            // 6
        { Ctor: Float32Array, size: 4 },           // 7
        { Ctor: Float64Array, size: 8 },           // 8
        { Ctor: BigInt64Array as never, size: 8 }, // 9
        { Ctor: BigUint64Array as never, size: 8 },// 10
      ];
      const ctorInfo = ctors[type];
      if (!ctorInfo) return origCreateTypedArray(env, type, length, ab_handle, byte_offset, result);
      const realOffset = wab.ptr + byte_offset;
      const view = new ctorInfo.Ctor(memory.buffer, realOffset, length);
      const handle = context.napiValueFromJsValue(view);
      if (result > 0) new DataView(memory.buffer).setUint32(result, Number(handle), true);
      void env;
      return 0;
    };
  }

  // napi_get_arraybuffer_info on our wasm-backed AB → return ptr + length
  // from our map.  emnapi's original would fail isArrayBuffer.
  // For non-wasm-backed ABs, sync wasm→JS first then delegate.

  // Override get_*_info to sync wasm → JS before delegating.  When edge's
  // C++ Buffer methods (hexSlice etc.) call napi_get_buffer_info, they want
  // the wasm address back.  emnapi's default getViewPointer/getArrayBufferPointer
  // does JS → wasm.  With external arraybuffers we skip that sync, but we
  // also need JS-side reads (user's `buf[i]`) to see edge's wasm writes —
  // so we sync wasm → JS at every read boundary.
  if (typeof origGetArrayBufferInfo === "function") {
    napiNs.napi_get_arraybuffer_info = (env: number, ab: number, data: number, byte_length: number) => {
      const wab = wasmBackedABs.get(ab);
      if (wab) {
        const dv = new DataView(memory.buffer);
        if (data > 0) dv.setUint32(data, wab.ptr, true);
        if (byte_length > 0) dv.setUint32(byte_length, wab.length, true);
        void env;
        return 0;
      }
      syncWasmToJs(ab);
      return origGetArrayBufferInfo(env, ab, data, byte_length);
    };
  }
  if (typeof origIsArrayBuffer === "function") {
    napiNs.napi_is_arraybuffer = (env: number, value: number, result: number) => {
      if (wasmBackedABs.has(value)) {
        new DataView(memory.buffer).setInt32(result, 1, true);
        void env;
        return 0;
      }
      return origIsArrayBuffer(env, value, result);
    };
  }
  if (typeof origGetTypedArrayInfo === "function") {
    napiNs.napi_get_typedarray_info = (env: number, ta: number, type: number, length: number, data: number, ab: number, off: number) => {
      syncWasmToJs(ta);
      return origGetTypedArrayInfo(env, ta, type, length, data, ab, off);
    };
  }
  if (typeof origGetBufferInfo === "function") {
    napiNs.napi_get_buffer_info = (env: number, buf: number, data: number, length: number) => {
      // syncWasmToJs fires BEFORE the C++ binding's memcpy, so a write
      // binding's call here captures pre-write bytes only.  Subsequent
      // napi-going reads (`toString`, `compare`, …) re-trigger this and
      // pull post-write bytes.  In wasm-aliased mode (default) JS and
      // wasm share storage so this is a no-op; in legacy emnapi-external
      // mode (no buffer-wasm-aliased policy) it provides the only sync.
      syncWasmToJs(buf);
      return origGetBufferInfo(env, buf, data, length);
    };
  }

  if (typeof origCreateBufferCopy === "function") {
    // napi_create_buffer_copy(env, length, src_data, result_data, result) —
    // copy bytes from wasm[src_data..src_data+length] into a new buffer.  We
    // allocate wasm memory and copy wasm→wasm; the resulting Buffer is a view
    // of wasmMemory.buffer at the new address.
    napiNs.napi_create_buffer_copy = (
      env: number, length: number, src_data: number, result_data: number, result: number,
    ) => {
      const allocd = allocWasmBuffer(length);
      if (!allocd) return origCreateBufferCopy(env, length, src_data, result_data, result);
      if (length > 0 && src_data > 0) {
        const u8 = new Uint8Array(memory.buffer);
        u8.copyWithin(allocd.ptr, src_data, src_data + length);
      }
      const dv = new DataView(memory.buffer);
      if (result_data > 0) dv.setUint32(result_data, allocd.ptr, true);
      const handle = context.napiValueFromJsValue(allocd.view);
      if (result > 0) dv.setUint32(result, Number(handle), true);
      void env;
      return 0;
    };
  }
}

// ─── Module-level accessors for the active wasm-side napi context ───
//
// R7 wiring (see experiments/r7-cbinfo-synthesis/FINDINGS.md): the
// reverse-RPC callback dispatcher in host-worker/callback-dispatch.ts
// needs access to the live wasm-side emnapi Context (to openScope /
// closeScope around the funcref invocation) and an Env (to pass to
// openScope).  These accessors let the dispatcher resolve both lazily
// at dispatch time — necessary because the dispatcher is registered
// BEFORE _start runs and any env is created.
//
// One NapiHost per worker is the invariant; the most-recently created
// host wins.
let activeNapiHost: NapiHost | null = null;
/** Returns the most-recently created NapiHost in this worker, or null
 *  if `createNapiHost` has not yet run. */
export function getActiveNapiHost(): NapiHost | null { return activeNapiHost; }
/** Returns the live wasm-side Context, or null if no NapiHost yet. */
export function getWasmCtx(): Context | null { return activeNapiHost?.context ?? null; }
/** Returns the first/active wasm-side Env, or undefined if no env has
 *  been created yet (envs are created by user code via
 *  `unofficial_napi_create_env` during _start). */
export function getWasmEnv(): Env | undefined {
  if (!activeNapiHost) return undefined;
  // Single-env is the common case; first-in-insertion-order Map iteration
  // matches what edge.js's bootstrap creates.
  const it = activeNapiHost.envs.values().next();
  return it.done ? undefined : it.value;
}

export function createNapiHost(opts: NapiHostOptions): NapiHost {
  const context = createContext();
  const envs = new Map<number, Env>();
  // V2 cutover: env that v2's init flow created (via our
  // emnapi_create_env stub).  Populated in bindInstance after
  // napiModule.init; passed to createUnofficialNapi via the holder so
  // unofficial_napi_create_env can reuse it (avoids v1 createEnv
  // signature mismatch on v2).  Stays null on v1.
  const v2InitEnvHolder: { value: Env | null } = { value: null };

  // Build emnapi's NapiModule (without instantiating any wasm yet).  This
  // pre-populates `napiModule.imports.napi` with all standard napi_* fns.
  //
  // V2 cutover: v2 moved core napi machinery into opt-in plugins (handle
  // scopes, async-work, threadsafe-functions).  Without plugins the wasm
  // fails to instantiate (napi_create_handle_scope is missing from the
  // import namespace).  V1 had these implicit; v2 makes them explicit so
  // embedders can pick the slice they need.  See `napi-host/emnapi.ts`
  // for the plugin source + Vite/tsconfig wiring.
  //
  // The cast satisfies V1's stale `CreateOptions` TS type that doesn't
  // list `plugins` — V1's runtime ignores the unknown field; V2 reads it.
  // After the v1→v2 cutover completes (npm @emnapi/* drops out, vendored
  // is the only runtime), the cast can come off.
  // #!~debt vendored-emnapi-flag — running with mixed v1 types + v2
  // runtime during the cutover transition.
  const napiModule: NapiModule = createNapiModule({
    context,
    filename: opts.filename ?? "edgejs",
    asyncWorkPoolSize: 0,
    plugins: [v8Plugin, asyncWorkPlugin, tsfnPlugin],
  } as Parameters<typeof createNapiModule>[0] & { plugins?: unknown[] });

  // Patch emnapi's napi_define_class / napi_define_properties.  Both walk a
  // property-descriptor array and call `emnapiDefineProperty`, which reads
  // `handleStore.get(value).value` in its `else` branch — without checking
  // that `value !== 0`.  When edge.js registers a class whose descriptor
  // has all of {method, getter, setter, value} zero (the standard N-API
  // way to declare "property with no initial value"), emnapi crashes
  // dereferencing handle 0.  We rewrite `value` from 0 to 1
  // (GlobalHandle.UNDEFINED) so emnapi resolves it to `undefined` — the
  // intended N-API semantics for a value-less descriptor.
  //
  // See NOTES.md 2026-05-21 "emnapi napi_define_class fix" for the trace.
  patchEmnapiDefineForEmptyValue(napiModule, opts.memory);

  // Captured at bindInstance time so napi_create_buffer* overrides can
  // _malloc from wasm memory.  Null until the instance binds — until then
  // the overrides fall through to emnapi's original (which uses JS
  // ArrayBuffers; the only callers before bind are emnapi's own init
  // helpers which don't expose buffers to edge).
  let wasmMallocImpl: ((n: number) => number) | null = null;
  patchEmnapiToUseWasmBackedBuffers(napiModule, opts.memory, context, () => wasmMallocImpl);

  // Real implementations of the four `unofficial_napi_*` microtask /
  // promise-hook ops that edge.js's C++ calls via the
  // `napi_extension_wasmer_v0` wasm import module.  Layered into the
  // standard napi imports here; the harness/worker splits them out into
  // the right import namespace at instantiation time.
  const microtaskOpsState: MicrotaskOpsState = createMicrotaskOpsState();
  const microtaskOps = buildMicrotaskOpsImports(context, microtaskOpsState);
  for (const [name, fn] of Object.entries(microtaskOps)) {
    (napiModule.imports.napi as Record<string, Function>)[name] = fn;
  }

  // Host-side `unhandledrejection` / `process.on('unhandledRejection')`
  // listeners forward to lib's callback (captured by
  // unofficial_napi_set_promise_reject_callback into microtaskOpsState).
  installHostPromiseRejectListeners(microtaskOpsState, opts.postLog);

  // Layer our unofficial_napi_* impls into the napi namespace.  This is the
  // ONE place edge-specific behavior is added on top of emnapi.
  // Normalize builtinOverrides into a Map for fast lookup; drop undefined entries.
  const builtinOverridesMap = new Map<string, ModuleOverride>();
  if (opts.builtinOverrides) {
    for (const [key, value] of Object.entries(opts.builtinOverrides)) {
      if (value === undefined) continue;
      builtinOverridesMap.set(key, value);
    }
  }
  const unofficial = createUnofficialNapi({
    context,
    memory: opts.memory,
    envs,
    v2InitEnvHolder,
    builtinOverrides: builtinOverridesMap,
    postLog: opts.postLog,
    // E9: route through the holder — wasm-side process.exit() lands here.
    // Holder.fn is wired AFTER createWasiShim returns; the wasm worker
    // can't issue terminate_execution until _start runs, by which time
    // the wiring is in place.
    requestExit: opts.requestExitHolder
      ? (code: number) => { opts.requestExitHolder?.fn?.(code); }
      : undefined,
  });
  for (const [name, fn] of Object.entries(unofficial)) {
    (napiModule.imports.napi as Record<string, Function>)[name] = fn;
  }

  // Lazy-loaded builtins (inspector, url, crypto, ...) reach the JS engine
  // via `napi_run_script` rather than `unofficial_napi_contextify_compile_function`
  // — see edge_module_loader.cc:EvaluateJsModule.  The script string is the
  // wrapped form `(function(internalBinding, primordials) {return function
  // (exports, require, module, __filename, __dirname) {\n<source>\n//#
  // sourceURL=node:<id>\n};})`.  To intercept, parse the sourceURL, look up
  // <id> in builtinOverrides, and rewrite the inner source before handing
  // off to emnapi's real napi_run_script.
  if (builtinOverridesMap.size > 0) {
    const napiNs = napiModule.imports.napi as Record<string, Function>;
    const origRunScript = napiNs.napi_run_script;
    // Wrapper shape (empirical, edge_module_loader.cc:EvaluateJsModule writes
    // a different form than the comment there suggests — single function,
    // not nested):
    //   (function(exports, require, module, process, internalBinding, primordials) {\n
    //   <source>\n
    //   })\n
    //   //# sourceURL=node:<id>\n
    //
    // Body is captured as group 2 so the `{ post }` shape can keep it and
    // splice the patch source AFTER it (inside the same function wrapper).
    const overrideRegex = /^(\(function\([^)]*\) \{\n)([\s\S]*)(\n\}\)\n\/\/# sourceURL=)/;
    napiNs.napi_run_script = (envHandle: number, scriptHandle: number, resultPtr: number): number => {
      const scriptValue = context.jsValueFromNapiValue(scriptHandle);
      if (typeof scriptValue === "string" && scriptValue.includes("//# sourceURL=node:")) {
        const m = scriptValue.match(/\/\/# sourceURL=(node:[^\n]+)/);
        if (m) {
          const filename = m[1];
          const bare = filename.startsWith("node:") ? filename.slice(5) : filename;
          let override: ModuleOverride | undefined;
          if (builtinOverridesMap.has(filename)) override = builtinOverridesMap.get(filename);
          else if (builtinOverridesMap.has(bare)) override = builtinOverridesMap.get(bare);
          if (override !== undefined && overrideRegex.test(scriptValue)) {
            // $1 = wrapper head, $2 = original body, $3 = wrapper tail
            let replacement: string | null = null;
            if (override === null) {
              replacement = "$1module.exports = {};$3";
            } else if (typeof override === "string") {
              // Escape `$` to keep the value's literal `$`-sequences from
              // being interpreted as backreferences in the replacement.
              replacement = "$1" + override.replace(/\$/g, "$$$$") + "$3";
            } else {
              // { pre?, post? } — keep original body, splice patches around it.
              const pre = override.pre ? "\n" + override.pre.replace(/\$/g, "$$$$") + "\n" : "";
              const post = override.post ? "\n" + override.post.replace(/\$/g, "$$$$") + "\n" : "";
              if (pre || post) replacement = "$1" + pre + "$2" + post + "$3";
            }
            if (replacement === null) {
              return origRunScript(envHandle, scriptHandle, resultPtr);
            }
            const replaced = scriptValue.replace(overrideRegex, replacement);
            opts.postLog?.(`[override] matched ${filename} (via run_script)`, "warn");
            const newHandle = context.napiValueFromJsValue(replaced);
            return origRunScript(envHandle, Number(newHandle), resultPtr);
          }
        }
      }
      return origRunScript(envHandle, scriptHandle, resultPtr);
    };
  }

  // Ensure env.memory is the shared memory the wasm imports.  emnapi looks at
  // `imports.env.memory` during instantiate if provided.
  (napiModule.imports.env as Record<string, unknown>).memory = opts.memory;

  const host: NapiHost = {
    imports: napiModule.imports as Record<string, Record<string, Function | WebAssembly.Memory>>,
    context,
    envs,
    bindInstance(realInstance, wasmModule) {
      // Capture the wasm's exported malloc so the Buffer-allocation
      // overrides above can carve regions out of wasm linear memory.
      const exp = realInstance.exports as Record<string, unknown>;
      const malloc =
        (typeof exp.unofficial_napi_guest_malloc === "function" && exp.unofficial_napi_guest_malloc) ||
        (typeof exp.malloc === "function" && exp.malloc) ||
        null;
      if (typeof malloc === "function") {
        wasmMallocImpl = malloc as (n: number) => number;
      }
      const { instance: proxied, envStructPtr } = createInstanceProxy(realInstance);

      // Track JS-driven wasm re-entries.  emnapi's napi callback
      // dispatch + setImmediate / next-tick handlers reach wasm via
      // `wasmTable.get(idx)(...)`.  Those re-enter wasm on a fresh JS
      // call stack — NO promising activation between us and the import
      // call.  So our Suspending impls must NOT return a Promise from
      // such re-entries: JSPI would reject with "trying to suspend
      // without WebAssembly.promising".  We mark these calls by
      // resetting __edgePromisingDepth to 0 during dispatch, then
      // restoring on return.  The Suspending impls check the depth
      // and pick sync vs async accordingly.
      //
      // call_indirect from inside wasm doesn't go through this Proxy's
      // `get` method (raw funcref entries), so wasm-internal callbacks
      // continue to suspend normally.
      const realTable = realInstance.exports.__indirect_function_table as WebAssembly.Table;
      type DepthHolder = { __edgePromisingDepth?: number };
      const wrappedTable = new Proxy(realTable, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return (idx: number): Function | null => {
              const fn = target.get(idx);
              if (typeof fn !== "function") return fn;
              return function jsReentryWrap(this: unknown, ...args: unknown[]): unknown {
                const dh = globalThis as DepthHolder;
                const prev = dh.__edgePromisingDepth ?? 0;
                dh.__edgePromisingDepth = 0;
                try {
                  return (fn as Function).apply(this, args);
                } finally {
                  dh.__edgePromisingDepth = prev;
                }
              };
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      napiModule.init({
        instance: proxied,
        module: wasmModule,
        memory: opts.memory,
        table: wrappedTable,
      });

      // V2 cutover: v2's init flow allocated an env struct via our
      // `emnapi_create_env` stub (instance-proxy.ts) and wrote
      // `envObject.id` at `envStructPtr.value + 24`.  After init the
      // module-level `emnapiEnv` reference (closure-private inside
      // emnapi-core.js) holds the Env, but napiModule.envObject is
      // already deleted (emnapi-core.js:407).  Recover the env id from
      // memory and stash the Env so `unofficial_napi_create_env` can
      // reuse it — calling context.createEnv again with v1 args would
      // fail because v2's signature is (filename, version, bridge,
      // nodeBinding) not (filename, version, vppp, vp, abort, binding).
      //
      // envStructPtr.value === 0 means v1 init ran (our stub never
      // fired), so leave v2InitEnv unset and the v1 fallback path will
      // create the env itself.
      if (envStructPtr.value !== 0) {
        const dv = new DataView(opts.memory.buffer);
        // Struct address v2 writes to is (ptr + 8 - 8 + 24) = ptr + 24
        // per emnapi-core.js:384.
        const envId = dv.getUint32(envStructPtr.value + 24, true);
        const env = context.getEnv(envId);
        if (env) {
          v2InitEnvHolder.value = env;
        }
      }

      // Expose just what the worker_threads policy + uv-async wrapper
      // consume: `uvAsync` (real-Path-A keepalive primitive) and
      // `wasmMemory` (for the lazy DataView fallback in uv-async.ts).
      // uvAsync is only populated when the guest exposes a malloc —
      // without one, we can't allocate the 64B uv_async_t handle.
      const uvAsync: UvAsyncRuntimeWithSize | undefined =
        typeof wasmMallocImpl === "function"
          ? createUvAsyncRuntime(realInstance, wasmMallocImpl)
          : undefined;
      (globalThis as {
        __edgeNapiHost?: {
          wasmMemory: WebAssembly.Memory;
          uvAsync?: UvAsyncRuntimeWithSize;
        };
      }).__edgeNapiHost = {
        wasmMemory: opts.memory,
        uvAsync,
      };
    },
  };
  activeNapiHost = host;
  return host;
}
