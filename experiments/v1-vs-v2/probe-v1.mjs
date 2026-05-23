// Run the same probe sequence as our v2 experiments — against v1 (1.10.0).
// We want to verify that v1 supports the same architectural patterns:
//   createContext + createNapiModule + napiModule.init + imports.napi
//
// If this passes with v1, the patterns are version-agnostic and we can
// stay on v1 for L5 F-1 without losing anything.

import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

console.log("=== Probe 1: API surface ===");
console.log("createContext type:", typeof createContext);
console.log("createNapiModule type:", typeof createNapiModule);

const ctx = createContext();
console.log("\ncreateContext OK:", typeof ctx);
console.log("ctx.refStore:", typeof ctx.refStore);

// v1 API: createNapiModule takes ContextOptions
let napiModule;
try {
  napiModule = createNapiModule({
    context: ctx,
    childThread: false,
    asyncWorkPoolSize: 0,
  });
  console.log("\ncreateNapiModule OK (v1 API)");
} catch (e) {
  console.log("\ncreateNapiModule v1 syntax failed:", e.message);
  console.log("Trying v1 alternate signature...");
  try {
    // v1 might use a different shape; try minimal opts.
    napiModule = createNapiModule({ context: ctx, asyncWorkPoolSize: 0 });
    console.log("createNapiModule OK (minimal opts)");
  } catch (e2) {
    console.log("createNapiModule failed:", e2.message);
    process.exit(1);
  }
}

console.log("napiModule.imports keys:", Object.keys(napiModule.imports));
const napiImports = napiModule.imports.napi ?? {};
console.log("imports.napi function count:", Object.keys(napiImports).length);
console.log("imports.napi sample:", Object.keys(napiImports).slice(0, 6));
console.log("imports.env count:", Object.keys(napiModule.imports.env ?? {}).length);
console.log("imports.emnapi count:", Object.keys(napiModule.imports.emnapi ?? {}).length);

console.log("\n=== Probe 2: napiModule.init signature ===");
const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
const wasmModule = new WebAssembly.Module(new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]));
const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
const stubInstance = {
  exports: {
    memory,
    malloc: () => 1024,
    free: () => {},
    __indirect_function_table: table,
    emnapi_create_env: () => 1,
    emnapi_delete_env: () => 0,
    emnapi_runtime_init: () => {},
    emnapi_runtime_finalize: () => {},
    napi_register_wasm_v1: () => 0,
  },
};
console.log("napiModule.init type:", typeof napiModule.init);
try {
  napiModule.init({ instance: stubInstance, module: wasmModule, memory, table });
  console.log("napiModule.init OK");
} catch (e) {
  console.log("napiModule.init threw:", e.message);
}

console.log("\n=== Probe 3: call napi_get_undefined via shared memory ===");
const memU32 = new Uint32Array(memory.buffer);
const fn = napiImports.napi_get_undefined;
if (typeof fn === "function") {
  const resultPtr = 2048;
  const status = fn(1, resultPtr);
  console.log(`napi_get_undefined(env=1, resultPtr=${resultPtr}) status=${status}`);
  if (status === 0) {
    console.log(`memory[2048] = handle id ${memU32[resultPtr / 4]}`);
  }
} else {
  console.log("napi_get_undefined not callable:", typeof fn);
}

console.log("\n=== Conclusion ===");
console.log("If status was 0 and handle was written, v1 supports our pattern.");
console.log("Final ctx.refStore size:", ctx.refStore.size);
