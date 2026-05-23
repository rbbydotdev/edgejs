// Q2 — full cross-worker napi roundtrip with real Node workers.
//
// Topology:
//   Main thread (= "host worker" in our L5 architecture):
//     - Creates the emnapi v2 context.
//     - Creates the napi module (gets imports.napi populated).
//     - Hosts the RPC server (drains request ring, dispatches to napi).
//     - Owns the shared wasm memory.
//
//   Worker thread (= "wasm worker"):
//     - Simulates wasm.  Doesn't run real wasm; just calls JS functions
//       that represent the napi imports.  Each "napi call" is a SAB-RPC
//       request to the host.
//     - Has direct access to the shared memory.
//
// This validates the full pipeline:
//   wasm-side stub → SAB request → host RPC server → host emnapi →
//   host writes result handle to shared memory → SAB reply → wasm-side
//   reads handle from memory.
//
// Result expected: wasm-side gets handle id 2 (for `undefined`).

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

// SAB layout for the RPC ring (matches our sab-ring.ts conventions):
//   [0] wake counter
//   [1] request status (0=empty, 1=ready)
//   [2] reply status (0=empty, 1=ready)
//   [3] op code
//   [4] arg0 (env)
//   [5] arg1 (result_ptr)
//   [6] reply status code
const SLOT_WAKE = 0;
const SLOT_REQ = 1;
const SLOT_REP = 2;
const SLOT_OP = 3;
const SLOT_ARG0 = 4;
const SLOT_ARG1 = 5;
const SLOT_REPSTATUS = 6;

const OP_NAPI_GET_UNDEFINED = 1;
const OP_NAPI_GET_NULL = 2;
const OP_NAPI_GET_GLOBAL = 3;

const TIMEOUT_MS = 5_000;

if (isMainThread) {
  // ── Main thread setup: emnapi context, RPC server, worker spawn ──
  const ctrlSab = new SharedArrayBuffer(64);
  const ctrl = new Int32Array(ctrlSab);

  // Wasm linear memory simulation — shared with worker.
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const memU32 = new Uint32Array(memory.buffer);

  // Boot a minimal valid wasm module so emnapi.init is happy.
  const wasmModule = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ]));
  const stubTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
  const stubInstance = {
    exports: {
      memory,
      malloc: (size) => {
        // Q1 pool resolution: bump allocator.  Pool starts at 1024.
        const ptr = poolNext;
        poolNext += (size + 7) & ~7;
        return ptr;
      },
      free: () => {},
      __indirect_function_table: stubTable,
      emnapi_create_env: () => 1, // env id 1
      emnapi_delete_env: () => 0,
      emnapi_runtime_init: () => {},
      emnapi_runtime_finalize: () => {},
      napi_register_wasm_v1: () => 0,
    },
  };
  let poolNext = 16384; // bytes; emnapi's call locations should land here

  const ctx = createContext();
  const napiModule = createNapiModule({
    context: ctx,
    childThread: false,
    asyncWorkPoolSize: 0,
  });
  napiModule.init({ instance: stubInstance, module: wasmModule, memory, table: stubTable });

  const napi = napiModule.imports.napi;

  // Op-code dispatch table.
  function dispatch(op, env, arg1) {
    switch (op) {
      case OP_NAPI_GET_UNDEFINED: return napi.napi_get_undefined(env, arg1);
      case OP_NAPI_GET_NULL: return napi.napi_get_null(env, arg1);
      case OP_NAPI_GET_GLOBAL: return napi.napi_get_global(env, arg1);
      default: return -1;
    }
  }

  // Spawn worker.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { ctrlSab, memory },
  });
  worker.on("message", (msg) => {
    console.log("[main] worker reported:", msg);
    if (msg.kind === "done") {
      worker.terminate();
      process.exit(msg.ok ? 0 : 1);
    }
  });
  worker.once("error", (e) => {
    console.error("[main] worker error:", e);
    process.exit(2);
  });

  // RPC server loop — drain incoming requests.
  let serving = true;
  (async function serve() {
    let lastWake = 0;
    while (serving) {
      // Async wait for new requests.
      const result = Atomics.waitAsync(ctrl, SLOT_WAKE, lastWake, TIMEOUT_MS);
      if (result.async) {
        const r = await result.value;
        if (r === "timed-out") break;
      }
      lastWake = Atomics.load(ctrl, SLOT_WAKE);

      // Drain any pending request.
      if (Atomics.load(ctrl, SLOT_REQ) === 1) {
        const op = Atomics.load(ctrl, SLOT_OP);
        const env = Atomics.load(ctrl, SLOT_ARG0);
        const arg1 = Atomics.load(ctrl, SLOT_ARG1);
        const status = dispatch(op, env, arg1);
        Atomics.store(ctrl, SLOT_REPSTATUS, status);
        Atomics.store(ctrl, SLOT_REP, 1);
        Atomics.store(ctrl, SLOT_REQ, 0);
        Atomics.notify(ctrl, SLOT_REP, 1);
      }
    }
  })();
} else {
  // ── Worker thread: simulates wasm.  Issues "napi calls" via RPC. ──
  const { ctrlSab, memory } = workerData;
  const ctrl = new Int32Array(ctrlSab);
  const memU32 = new Uint32Array(memory.buffer);

  function callNapi(op, env, arg1, replyResultPtr) {
    Atomics.store(ctrl, SLOT_OP, op);
    Atomics.store(ctrl, SLOT_ARG0, env);
    Atomics.store(ctrl, SLOT_ARG1, arg1);
    Atomics.store(ctrl, SLOT_REP, 0);
    Atomics.store(ctrl, SLOT_REQ, 1);
    Atomics.add(ctrl, SLOT_WAKE, 1);
    Atomics.notify(ctrl, SLOT_WAKE, 1);
    // Sync wait for reply.
    while (Atomics.load(ctrl, SLOT_REP) === 0) {
      Atomics.wait(ctrl, SLOT_REP, 0, 1000);
    }
    const status = Atomics.load(ctrl, SLOT_REPSTATUS);
    // Read handle id from shared memory (host wrote it there).
    const handle = memU32[replyResultPtr / 4];
    return { status, handle };
  }

  // Three real napi calls via RPC.
  const r1 = callNapi(OP_NAPI_GET_UNDEFINED, 1, 100, 100);
  console.log(`[worker] napi_get_undefined: status=${r1.status} handle=${r1.handle}`);

  const r2 = callNapi(OP_NAPI_GET_NULL, 1, 200, 200);
  console.log(`[worker] napi_get_null:      status=${r2.status} handle=${r2.handle}`);

  const r3 = callNapi(OP_NAPI_GET_GLOBAL, 1, 300, 300);
  console.log(`[worker] napi_get_global:    status=${r3.status} handle=${r3.handle}`);

  // Verify: all should succeed, handles should be distinct.
  const ok = r1.status === 0 && r2.status === 0 && r3.status === 0
    && r1.handle !== 0 && r2.handle !== 0 && r3.handle !== 0
    && r1.handle !== r2.handle;
  parentPort.postMessage({ kind: "done", ok, r1, r2, r3 });
}
