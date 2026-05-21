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
// Edge's Buffer methods (`hexSlice`, `utf8Slice`, etc. via `internalBinding('buffer')`)
// are C++ in the wasm.  They read from the wasm mirror address P, not from
// the JS ArrayBuffer.  Since emnapi never syncs the mirror back, edge's
// `buffer.toString('hex')` reads stale/empty bytes from wasm[P], producing
// JS-source-looking heap garbage instead of the digest.
//
// Fix: after emnapi's call returns, copy wasm[data..data+length] →
// wasm[P..P+length] so the mirror matches the source.  Same fix needed for
// `napi_create_buffer` (which takes a data out-ptr, edge writes to it after
// the call) — for that one we just ensure the JS ArrayBuffer and the wasm
// mirror are synced via the SAME backing store, which the existing
// getArrayBufferPointer path already does for create_buffer.  So only
// create_buffer_copy needs this patch.
function patchEmnapiBufferMirror(napiModule: NapiModule, memory: WebAssembly.Memory): void {
  const napiNs = napiModule.imports.napi as Record<string, Function>;
  const origCopy = napiNs.napi_create_buffer_copy;
  if (typeof origCopy !== "function") return;
  napiNs.napi_create_buffer_copy = (
    env: number, length: number, data: number, result_data: number, result: number,
  ) => {
    const ret = origCopy(env, length, data, result_data, result);
    if (ret === 0 && result_data > 0 && data > 0 && length > 0) {
      const dv = new DataView(memory.buffer);
      const mirrorPtr = dv.getUint32(result_data, true);
      if (mirrorPtr > 0) {
        const u8 = new Uint8Array(memory.buffer);
        u8.copyWithin(mirrorPtr, data, data + length);
      }
    }
    return ret;
  };
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

  patchEmnapiBufferMirror(napiModule, opts.memory);

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
