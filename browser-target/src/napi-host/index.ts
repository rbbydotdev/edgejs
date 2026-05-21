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

import { createContext, type Context, type Env } from "@emnapi/runtime";
import { createNapiModule, type NapiModule } from "@emnapi/core";
import { createInstanceProxy } from "./instance-proxy";
import { createUnofficialNapi } from "./unofficial";

export interface NapiHostOptions {
  memory: WebAssembly.Memory;
  /** Optional filename for diagnostics; surfaces in stack traces from the env. */
  filename?: string;
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
  const origGetArrayBufferInfo = napiNs.napi_get_arraybuffer_info;
  const origGetTypedArrayInfo = napiNs.napi_get_typedarray_info;
  const origGetBufferInfo = napiNs.napi_get_buffer_info;

  // emnapi exposes its memory-sync primitive via napiModule.emnapi.syncMemory.
  // Call signature: (js_to_wasm: boolean, view: TypedArray|ArrayBuffer, offset, len) → value.
  // js_to_wasm=false copies wasm → JS, which is the direction we need for
  // edge.js's wasm-source-of-truth Buffer model.
  const emnapiNs = (napiModule as unknown as { emnapi: { syncMemory?: (js_to_wasm: boolean, view: unknown, offset: number, len: number) => unknown } }).emnapi;
  function syncWasmToJs(handleId: number): void {
    if (!emnapiNs?.syncMemory) return;
    const value = context.handleStore.get(handleId)?.value;
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
    // BufferPolyfill.from(SAB, offset, len) returns a Uint8Array view with
    // Buffer.prototype — view.buffer === memory.buffer (the SAB).
    const BufferCtor = (globalThis as { Buffer: { from(b: ArrayBufferLike, o: number, l: number): Uint8Array } }).Buffer;
    const view = BufferCtor.from(memory.buffer, ptr, byteLength);
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
      const handle = context.addToCurrentScope(allocd.view);
      if (result > 0) dv.setUint32(result, handle.id, true);
      void env;
      return 0; // napi_ok
    };
  }


  // Override napi_create_arraybuffer to allocate wasm memory and route
  // through emnapi's EXTERNAL arraybuffer path.  External arraybuffers get
  // cached with `runtimeAllocated: 0`, which means emnapi will NOT do its
  // JS→wasm sync inside getArrayBufferPointer — preserving any wasm-side
  // writes edge.js's C++ makes after the buffer is created.
  //
  // Without this fix, emnapi clobbers edge's wasm writes with JS-side zeros
  // every time napi_get_*_info is called (which happens for every C++
  // Buffer accessor like hexSlice, utf8Slice, etc.).
  if (typeof origCreateArrayBuffer === "function" && typeof origCreateExternalArrayBuffer === "function") {
    napiNs.napi_create_arraybuffer = (env: number, byte_length: number, data_out: number, result: number) => {
      const malloc = getMalloc();
      if (!malloc) return origCreateArrayBuffer(env, byte_length, data_out, result);
      const ptr = malloc(byte_length);
      if (!ptr) return origCreateArrayBuffer(env, byte_length, data_out, result);
      // Route through napi_create_external_arraybuffer.  emnapi:
      //   1. creates a fresh JS ArrayBuffer of byte_length
      //   2. copies wasm[ptr..ptr+byte_length] into it (snapshot — zeros for fresh malloc)
      //   3. caches with {address: ptr, runtimeAllocated: 0}
      //   4. writes handle to *result
      const status = origCreateExternalArrayBuffer(env, ptr, byte_length, 0, 0, result);
      if (status === 0 && data_out > 0) {
        new DataView(memory.buffer).setUint32(data_out, ptr, true);
      }
      return status;
    };
  }

  // Override get_*_info to sync wasm → JS before delegating.  When edge's
  // C++ Buffer methods (hexSlice etc.) call napi_get_buffer_info, they want
  // the wasm address back.  emnapi's default getViewPointer/getArrayBufferPointer
  // does JS → wasm.  With external arraybuffers we skip that sync, but we
  // also need JS-side reads (user's `buf[i]`) to see edge's wasm writes —
  // so we sync wasm → JS at every read boundary.
  if (typeof origGetArrayBufferInfo === "function") {
    napiNs.napi_get_arraybuffer_info = (env: number, ab: number, data: number, byte_length: number) => {
      syncWasmToJs(ab);
      return origGetArrayBufferInfo(env, ab, data, byte_length);
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
      const handle = context.addToCurrentScope(allocd.view);
      if (result > 0) dv.setUint32(result, handle.id, true);
      void env;
      return 0;
    };
  }
}

export function createNapiHost(opts: NapiHostOptions): NapiHost {
  const context = createContext();
  const envs = new Map<number, Env>();

  // Build emnapi's NapiModule (without instantiating any wasm yet).  This
  // pre-populates `napiModule.imports.napi` with all standard napi_* fns.
  const napiModule: NapiModule = createNapiModule({
    context,
    filename: opts.filename ?? "edgejs",
    asyncWorkPoolSize: 0,
  });

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

  // Layer our unofficial_napi_* impls into the napi namespace.  This is the
  // ONE place edge-specific behavior is added on top of emnapi.
  const unofficial = createUnofficialNapi({ context, memory: opts.memory, envs });
  for (const [name, fn] of Object.entries(unofficial)) {
    (napiModule.imports.napi as Record<string, Function>)[name] = fn;
  }

  // Ensure env.memory is the shared memory the wasm imports.  emnapi looks at
  // `imports.env.memory` during instantiate if provided.
  (napiModule.imports.env as Record<string, unknown>).memory = opts.memory;

  return {
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
      const proxied = createInstanceProxy(realInstance);
      napiModule.init({
        instance: proxied,
        module: wasmModule,
        memory: opts.memory,
        table: realInstance.exports.__indirect_function_table as WebAssembly.Table,
      });
    },
  };
}
