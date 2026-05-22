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
};

export function createInstanceProxy(
  realInstance: WebAssembly.Instance,
  stubs: Partial<Stubs> = {},
): WebAssembly.Instance {
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
  };
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

  return new Proxy(realInstance, {
    get(target, key, receiver) {
      if (key === "exports") return proxiedExports;
      return Reflect.get(target, key, receiver);
    },
  });
}
