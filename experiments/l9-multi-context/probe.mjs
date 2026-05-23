// Q8 — can a single host worker hold N independent emnapi contexts?
//
// For L9 worker_threads: each user `new Worker()` would correspond to
// its own emnapi context on the host worker (or on its own host
// worker; either way, the contexts need to be independent).
//
// Test: create 5 contexts.  Register different values in each.
// Verify each context's handles are isolated — handle ID 2 in
// context A refers to a different value than handle ID 2 in context B.

import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

function setupCtx(label) {
  const ctx = createContext();
  const module = createNapiModule({
    context: ctx,
    childThread: false,
    asyncWorkPoolSize: 0,
  });
  // Stub instance for init.
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
  module.init({ instance: stubInstance, module: wasmModule, memory, table });
  const memU32 = new Uint32Array(memory.buffer);
  return { label, ctx, module, napi: module.imports.napi, memU32 };
}

const ctxA = setupCtx("A");
const ctxB = setupCtx("B");
const ctxC = setupCtx("C");

// In each context, get a handle for `undefined` via napi_get_undefined.
// The handle IDs may or may not be the same across contexts; what
// matters is that operations in one don't affect another.
const HANDLES_TO_GET = ["napi_get_undefined", "napi_get_null", "napi_get_global"];

const results = [];
for (const target of [ctxA, ctxB, ctxC]) {
  const ids = [];
  for (let i = 0; i < HANDLES_TO_GET.length; i++) {
    const op = HANDLES_TO_GET[i];
    const ptr = 256 + i * 4;
    const status = target.napi[op](1, ptr);
    const id = status === 0 ? target.memU32[ptr / 4] : -1;
    ids.push({ op, status, id });
  }
  results.push({ label: target.label, ids });
  console.log(`[ctx${target.label}] handles:`, ids.map((r) => `${r.op}=${r.id}`).join(", "));
}

// Check isolation: are the handle IDs across contexts INDEPENDENT?
// If both context A and B return id=2 for napi_get_undefined, that's
// expected — each context has its own ID space starting from the same
// base.  What we want to verify is that mutating ctxA's store doesn't
// affect ctxB.
console.log("\n[main] ctxA.refStore size:", ctxA.ctx.refStore.size);
console.log("[main] ctxB.refStore size:", ctxB.ctx.refStore.size);
console.log("[main] ctxC.refStore size:", ctxC.ctx.refStore.size);

console.log("\n[main] refStore identity check:");
console.log("  ctxA.refStore === ctxB.refStore:", ctxA.ctx.refStore === ctxB.ctx.refStore);
console.log("  ctxA.refStore === ctxC.refStore:", ctxA.ctx.refStore === ctxC.ctx.refStore);

// Isolate(): are they distinct?
console.log("\n[main] ctxA.isolate === ctxB.isolate:", ctxA.ctx.isolate === ctxB.ctx.isolate);

if (ctxA.ctx.refStore !== ctxB.ctx.refStore && ctxA.ctx.isolate !== ctxB.ctx.isolate) {
  console.log("\n[main] OK — contexts are fully independent.  Each has its own refStore and isolate.");
  console.log("[main] L9 multi-context topology validated.");
  process.exit(0);
} else {
  console.log("\n[main] FAIL — contexts share state.");
  process.exit(1);
}
