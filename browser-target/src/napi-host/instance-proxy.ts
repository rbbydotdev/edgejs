// emnapi's `napiModule.init({instance, ...})` requires the wasm instance to
// export `malloc`, `free`, and `napi_register_wasm_v1`.  Those exist on wasms
// built WITH emnapi's preamble (e.g. napi-rs addons).  edgejs.wasm doesn't
// have them because it embeds its own full Node.js runtime instead.
//
// We satisfy emnapi by handing it a Proxy that wraps our real instance and
// returns JS-side stubs for the three missing exports.  After init runs,
// emnapi captures `wasmMemory`/`wasmTable` internally and never touches the
// missing exports again on the boot path.
//
// `malloc`/`free` will need real impls only when emnapi has to allocate IN
// wasm memory from JS — async work bookkeeping, threadsafe-function queues.
// For straight boot they're untouched.  For safety we throw on any call so
// it's loud, not silent, if a code path reaches them.

type Stubs = {
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  napi_register_wasm_v1: (envId: number, exportsHandleId: number) => number;
  // V2 cutover: emnapi v2 hardcodes `instance.exports.emnapi_create_env`
  // / `emnapi_delete_env` lookups in its module init flow (it calls
  // them, takes the returned pointer, treats `ptr + 8 ..  ptr + 64` as
  // the env native struct, writes `env.id` at offset+24, and assigns
  // the resulting env to the module-level `emnapiEnv` reference that
  // every napi_* op reads).  edge.js's wasm doesn't export these (we
  // use our own `unofficial_napi_create_env` flow).  Stubbing them via
  // `guestMalloc`/`guestFree` lets v2's init run to completion so
  // `emnapiEnv` gets set — the struct is opaque to OUR wasm (we never
  // read it back), it just needs to be a stable address in wasm memory.
  // V1 doesn't look up these exports, so the stubs are a no-cost
  // additive change there.
  //
  // Each stub returns / takes a u32 wasm pointer.
  emnapi_create_env: () => number;
  emnapi_delete_env: (ptr: number) => void;
};

// Size of v2's NapiEnv native struct (8-byte preamble + 56-byte
// NapiEnvOffset32 fields).  See `vendor/emnapi/packages/core/dist/
// emnapi-core.js` around the `address = _emnapi_create_env(); address
// += 8; HEAP_DATA_VIEW.setUint32(address - 8 + 24 ...)` sequence — the
// max offset we observed was 24 (Id); 56 bytes total leaves headroom
// for the other NapiEnvOffset32 fields v2 also writes.
const V2_NAPI_ENV_STRUCT_SIZE = 64;

/** Result of `createInstanceProxy` — the proxy AND an out-param holder
 *  for v2's env-struct pointer.  V2's init flow reads
 *  `instance.exports.emnapi_create_env()` and writes `envObject.id` at
 *  `returned_ptr + 24`.  After `napiModule.init` returns, the caller
 *  reads `envStructPtr.value + 24` from wasm memory to recover the env
 *  id — Context.getEnv(id) then gives the Env object emnapi created.
 *  Tracking the pointer here keeps the proxy single-source for the
 *  v2 bridge state.  V1 init never calls our stub so `value` stays 0. */
export interface InstanceProxyResult {
  instance: WebAssembly.Instance;
  envStructPtr: { value: number };
}

export function createInstanceProxy(
  realInstance: WebAssembly.Instance,
  stubs: Partial<Stubs> = {},
): InstanceProxyResult {
  // edgejs.wasm exports `unofficial_napi_guest_malloc` + (post-rebuild)
  // `unofficial_napi_guest_free` so host JS can allocate guest-backed
  // memory for ArrayBuffer / typed-array bridging (see WASIX_TODO.md
  // and wasix/src/wasix_compat.cc).  Route emnapi's malloc/free through
  // them.  When `guest_free` is missing (older wasm), fall back to a
  // logged no-op — leaks but doesn't crash.
  const exports = realInstance.exports as Record<string, unknown>;
  const guestMalloc = exports["unofficial_napi_guest_malloc"];
  const guestFree = exports["unofficial_napi_guest_free"];

  const defaultStubs: Stubs = {
    malloc: typeof guestMalloc === "function"
      ? ((size) => (guestMalloc as (n: number) => number)(size))
      : ((size) => {
          throw new Error(`malloc(${size}) called but wasm has no allocator`);
        }),
    free: typeof guestFree === "function"
      ? ((ptr) => { (guestFree as (p: number) => void)(ptr); })
      : (() => { /* pre-rebuild wasm has no guest_free; emnapi-side allocs leak */ }),
    // #!~debt no-op: edge doesn't actually use the napi_register_wasm_v1
    // contract (it's not a napi-rs addon — it IS the runtime).  Returning 0
    // tells emnapi "no exports to register," which is harmless.
    napi_register_wasm_v1: () => 0,
    // V2 cutover stubs — see Stubs type comment for the protocol.  The
    // pointer returned by `emnapi_create_env` is captured on
    // `envStructPtr.value` so `bindInstance` can read the env id back
    // from wasm memory after `napiModule.init` writes it at offset+24.
    emnapi_create_env: typeof guestMalloc === "function"
      ? () => {
          const ptr = (guestMalloc as (n: number) => number)(V2_NAPI_ENV_STRUCT_SIZE);
          envStructPtr.value = ptr;
          return ptr;
        }
      : () => {
          throw new Error(
            "emnapi_create_env stub: wasm has no guest allocator " +
            "(unofficial_napi_guest_malloc missing); v2 init can't run",
          );
        },
    emnapi_delete_env: typeof guestFree === "function"
      ? (ptr: number) => { (guestFree as (p: number) => void)(ptr); }
      : () => { /* leak; pre-rebuild wasm has no guest_free */ },
  };

  // Out-param: v2's init flow writes envObject.id at envStructPtr.value
  // + 24.  V1 init never calls our emnapi_create_env stub, so the value
  // stays 0 — bindInstance can use 0 as "v2 init did NOT run" signal.
  const envStructPtr: { value: number } = { value: 0 };
  const merged = { ...defaultStubs, ...stubs };

  const proxiedExports = new Proxy(realInstance.exports, {
    get(target, key, receiver) {
      if (typeof key === "string" && key in merged) {
        const existing = (target as Record<string, unknown>)[key];
        if (typeof existing === "function") return existing;
        return (merged as Record<string, Function>)[key];
      }
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string" && key in merged) return true;
      return Reflect.has(target, key);
    },
  });

  const instance = new Proxy(realInstance, {
    get(target, key, receiver) {
      if (key === "exports") return proxiedExports;
      return Reflect.get(target, key, receiver);
    },
  });

  return { instance, envStructPtr };
}
