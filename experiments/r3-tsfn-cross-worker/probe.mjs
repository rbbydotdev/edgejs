// Q3 empirical — does emnapi v2's tsfn actually dispatch correctly when
// the caller of napi_call_threadsafe_function lives on a worker thread
// that does NOT own the emnapi context?
//
// Topology (inverted from l5-real-roundtrip to match L5 architecture):
//   MAIN thread = "wasm worker"
//     - Does not own emnapi.  Just sends SAB-RPC requests.
//     - Has shared wasm memory.
//
//   WORKER thread = "host worker"
//     - Owns emnapi context (childThread: false).
//     - Registers a tsfn whose JS callback pushes data into a JS array
//       and signals main via postMessage on each fire.
//     - Receives RPC requests and dispatches to napi.imports.napi.*
//
// Test plan:
//   1. Host registers tsfn with JS callback that appends to received[].
//   2. Host sends tsfn handle (uint32 pointer into wasm memory) to main.
//   3. Main calls napi_call_threadsafe_function(handle, data, mode) via RPC,
//      50 times, with varied payloads (we write a uint32 to shared memory
//      at the `data` pointer ahead of time; callback reads it).
//   4. Verify all 50 callbacks fire on host worker, in order, with correct
//      payloads.
//   5. Test both blocking and non-blocking modes.
//
// Note on tsfn callback signature:
//   When call_js_cb=0 and a JS function is registered, emnapi calls
//   jsCallback() with NO arguments.  To verify per-call payloads, our
//   JS callback reads from a small "test ring" we maintain in shared
//   memory at a fixed offset, indexed by call count.

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";
import { tsfn as tsfnPlugin } from "@emnapi/core/plugins";

// ── SAB ring layout ────────────────────────────────────────────────
//  [0] wake counter
//  [1] request status (0=empty, 1=ready)
//  [2] reply status (0=empty, 1=ready)
//  [3] op code
//  [4] arg0 (env / handle low)
//  [5] arg1 (data ptr)
//  [6] arg2 (mode)
//  [7] reply status code (napi_status)
//  [8] reply value (e.g. tsfn handle on create)
const SLOT_WAKE = 0;
const SLOT_REQ = 1;
const SLOT_REP = 2;
const SLOT_OP = 3;
const SLOT_ARG0 = 4;
const SLOT_ARG1 = 5;
const SLOT_ARG2 = 6;
const SLOT_REPSTATUS = 7;
const SLOT_REPVAL = 8;

const OP_INIT_TSFN = 1;        // host creates the tsfn; returns handle
const OP_CALL_TSFN = 2;        // dispatch a tsfn call; arg0=handle, arg1=data, arg2=mode
const OP_RELEASE_TSFN = 3;
const OP_DRAIN = 4;            // ask host to process pending setImmediate work

// payload offset region in shared memory; main writes uint32s here
// (these are NOT real malloc'd ptrs, they're fixed addresses we control).
const PAYLOAD_BASE = 8192;     // 8KiB into linear memory
const PAYLOAD_SLOT_BYTES = 16; // each payload slot = 16 bytes

const TIMEOUT_MS = 5_000;
const N_CALLS = 50;

if (isMainThread) {
  // ── MAIN = wasm worker ────────────────────────────────────────────
  const ctrlSab = new SharedArrayBuffer(64);
  const ctrl = new Int32Array(ctrlSab);

  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const memU32 = new Uint32Array(memory.buffer);

  // Pre-fill 50 payload slots with varied data.  Each slot's first uint32
  // is the "call index" and second uint32 is a varying "payload" (size or
  // value).  Larger calls write longer byte runs.
  const payloads = [];
  for (let i = 0; i < N_CALLS; i++) {
    const slotPtr = PAYLOAD_BASE + i * PAYLOAD_SLOT_BYTES;
    const payloadVal = (i * 31 + 7) >>> 0;        // varying payload
    const payloadSize = 1 + (i % 5);              // varying "size" 1..5 uint32s
    memU32[slotPtr / 4] = i;                      // call index
    memU32[slotPtr / 4 + 1] = payloadVal;
    memU32[slotPtr / 4 + 2] = payloadSize;
    payloads.push({ slotPtr, payloadVal, payloadSize });
  }

  // Notification port for host→main "callback fired" messages.
  const { port1: hostToMain, port2: mainSideOfHost } = new MessageChannel();
  const callbacksFired = []; // entries pushed as host posts them

  hostToMain.on("message", (msg) => {
    if (msg && msg.kind === "callback") {
      callbacksFired.push(msg);
    }
  });

  const worker = new Worker(new URL(import.meta.url), {
    workerData: { ctrlSab, memory, hostPort: mainSideOfHost },
    transferList: [mainSideOfHost],
  });

  let hostReady = false;
  let tsfnHandle = 0;
  worker.on("message", (msg) => {
    if (msg.kind === "ready") {
      hostReady = true;
      tsfnHandle = msg.tsfnHandle;
      console.log(`[main] host ready, tsfnHandle=0x${tsfnHandle.toString(16)}`);
      runTest().catch((e) => {
        console.error("[main] test error:", e);
        process.exit(2);
      });
    } else if (msg.kind === "done") {
      worker.terminate();
      process.exit(msg.ok ? 0 : 1);
    } else if (msg.kind === "log") {
      console.log("[host]", msg.text);
    }
  });
  worker.once("error", (e) => {
    console.error("[main] worker error:", e);
    process.exit(2);
  });

  async function callRpc(op, arg0, arg1, arg2) {
    Atomics.store(ctrl, SLOT_OP, op);
    Atomics.store(ctrl, SLOT_ARG0, arg0 | 0);
    Atomics.store(ctrl, SLOT_ARG1, arg1 | 0);
    Atomics.store(ctrl, SLOT_ARG2, arg2 | 0);
    Atomics.store(ctrl, SLOT_REP, 0);
    Atomics.store(ctrl, SLOT_REQ, 1);
    Atomics.add(ctrl, SLOT_WAKE, 1);
    Atomics.notify(ctrl, SLOT_WAKE, 1);

    // Async-wait for reply.  We're on main; main can use waitAsync.
    while (Atomics.load(ctrl, SLOT_REP) === 0) {
      const r = Atomics.waitAsync(ctrl, SLOT_REP, 0, TIMEOUT_MS);
      if (r.async) {
        const v = await r.value;
        if (v === "timed-out") throw new Error("RPC timeout");
      }
    }
    return {
      status: Atomics.load(ctrl, SLOT_REPSTATUS),
      value: Atomics.load(ctrl, SLOT_REPVAL) >>> 0,
    };
  }

  async function runTest() {
    console.log(`[main] starting ${N_CALLS} cross-worker tsfn calls...`);

    // First 25 in blocking mode (mode=0), next 25 in non-blocking mode (mode=1).
    for (let i = 0; i < N_CALLS; i++) {
      const mode = i < 25 ? 0 : 1; // 0=blocking, 1=nonblocking
      const { slotPtr } = payloads[i];
      const r = await callRpc(OP_CALL_TSFN, tsfnHandle, slotPtr, mode);
      if (r.status !== 0) {
        console.error(`[main] call ${i} failed: status=${r.status}`);
        worker.postMessage({ kind: "shutdown" });
        await new Promise(res => setTimeout(res, 100));
        process.exit(1);
      }
    }

    console.log(`[main] all ${N_CALLS} RPC dispatches completed.`);
    console.log(`[main] asking host to drain pending setImmediate work...`);

    // Drive the host's event loop a few times to let setImmediate chains fire.
    // We poll by issuing OP_DRAIN which is just a no-op RPC that requires the
    // host's microtask queue to settle to reply.
    let lastCount = -1;
    let stableTicks = 0;
    for (let i = 0; i < 50; i++) {
      await callRpc(OP_DRAIN, 0, 0, 0);
      await new Promise(res => setImmediate(res)); // yield main
      if (callbacksFired.length === lastCount) {
        stableTicks++;
        if (stableTicks >= 5 && callbacksFired.length >= N_CALLS) break;
      } else {
        stableTicks = 0;
        lastCount = callbacksFired.length;
      }
    }

    console.log(`[main] host reported ${callbacksFired.length} callback fires.`);

    // Validate
    let ok = callbacksFired.length === N_CALLS;
    let mismatches = 0;
    for (let i = 0; i < Math.min(callbacksFired.length, N_CALLS); i++) {
      const cb = callbacksFired[i];
      const want = payloads[i];
      if (cb.callIndex !== i || cb.payloadVal !== want.payloadVal
          || cb.payloadSize !== want.payloadSize) {
        mismatches++;
        if (mismatches <= 5) {
          console.log(`[main]   mismatch @${i}: got`, cb, "want", want);
        }
      }
    }
    if (mismatches > 0) {
      console.log(`[main]   total mismatches: ${mismatches}`);
      ok = false;
    }

    console.log(`[main] RESULT: ${ok ? "PASS" : "FAIL"}`);
    console.log(`[main]   total callbacks fired: ${callbacksFired.length}/${N_CALLS}`);
    console.log(`[main]   first callback:`, callbacksFired[0]);
    console.log(`[main]   last  callback:`, callbacksFired[callbacksFired.length - 1]);

    worker.postMessage({ kind: "shutdown" });
    await new Promise(res => setTimeout(res, 100));
    process.exit(ok ? 0 : 1);
  }
} else {
  // ── WORKER = host worker ──────────────────────────────────────────
  const { ctrlSab, memory, hostPort } = workerData;
  const ctrl = new Int32Array(ctrlSab);
  const memU32 = new Uint32Array(memory.buffer);

  // Stub wasm instance for emnapi.init.
  const wasmModule = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ]));
  const stubTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
  let poolNext = 16384;
  const stubInstance = {
    exports: {
      memory,
      malloc: (size) => {
        const ptr = poolNext;
        poolNext += (size + 7) & ~7;
        return ptr;
      },
      free: () => {},
      __indirect_function_table: stubTable,
      emnapi_create_env: () => 1,
      emnapi_delete_env: () => 0,
      emnapi_runtime_init: () => {},
      emnapi_runtime_finalize: () => {},
      napi_register_wasm_v1: () => 0,
    },
  };

  const ctx = createContext();
  const napiModule = createNapiModule({
    context: ctx,
    childThread: false, // critical: host is the "main" of emnapi
    asyncWorkPoolSize: 0,
    plugins: [tsfnPlugin],
  });
  napiModule.init({ instance: stubInstance, module: wasmModule, memory, table: stubTable });
  const napi = napiModule.imports.napi;

  const ENV = 1;

  // Register a JS function that will be the tsfn callback.
  // The callback fires with NO arguments (since call_js_cb=0).  It reads
  // the most-recent "data" pointer that we cached in a JS-side queue.
  // emnapi calls our JS callback once per dispatched data; we mirror that
  // pacing by maintaining a parallel JS queue of pending datas pushed by
  // OP_CALL_TSFN; the callback pops from it.
  const pendingDatas = [];
  let totalFires = 0;

  const callback = function () {
    // Pop the data pointer that corresponds to this fire.
    const data = pendingDatas.shift();
    // Read the per-call payload from shared memory.
    const callIndex = memU32[data / 4];
    const payloadVal = memU32[data / 4 + 1];
    const payloadSize = memU32[data / 4 + 2];
    totalFires++;
    hostPort.postMessage({
      kind: "callback",
      callIndex,
      payloadVal,
      payloadSize,
      data,
      totalFires,
    });
  };

  // We need to put `callback` into the napi handle space so we can pass it
  // to napi_create_threadsafe_function.  Look up the env created during
  // init(), open a scope, and stash our JS callback as a napi_value.  The
  // tsfn create call internally creates a kUserland Reference from it
  // (see threadsafe-function.ts ~876) which keeps it live across scope
  // closure.
  const envObject = ctx.getEnv(1);
  if (!envObject) throw new Error("env 1 not found in ctx");
  const scope = ctx.openScope(envObject);
  const callbackHandle = Number(ctx.napiValueFromJsValue(callback));
  const resNameHandle = Number(ctx.napiValueFromJsValue("r3-tsfn"));

  // Allocate space for the tsfn out-ptr result.
  const TSFN_RESULT_PTR = 4096;
  memU32[TSFN_RESULT_PTR / 4] = 0;

  // Call napi_create_threadsafe_function.
  // Signature: (env, func, async_resource, async_resource_name,
  //             max_queue_size, initial_thread_count, thread_finalize_data,
  //             thread_finalize_cb, context, call_js_cb, result) -> napi_status
  const createStatus = napi.napi_create_threadsafe_function(
    ENV,
    callbackHandle,
    0,               // async_resource
    resNameHandle,
    0,               // max_queue_size: 0 = unlimited
    1,               // initial_thread_count
    0, 0,            // thread_finalize_data, cb
    0,               // context
    0,               // call_js_cb (we use the JS function directly)
    TSFN_RESULT_PTR,
  );
  ctx.closeScope(envObject, scope);
  if (createStatus !== 0) {
    parentPort.postMessage({ kind: "log", text: `tsfn create FAILED status=${createStatus}` });
    parentPort.postMessage({ kind: "done", ok: false });
    process.exit(1);
  }
  const tsfnHandle = memU32[TSFN_RESULT_PTR / 4];
  parentPort.postMessage({ kind: "log", text: `tsfn created, handle=0x${tsfnHandle.toString(16)}` });

  // Dispatch table.
  function dispatch(op, arg0, arg1, arg2) {
    switch (op) {
      case OP_CALL_TSFN: {
        // arg0 = handle, arg1 = data ptr, arg2 = mode
        pendingDatas.push(arg1 >>> 0);
        const status = napi.napi_call_threadsafe_function(arg0 >>> 0, arg1 >>> 0, arg2 | 0);
        return { status, value: 0 };
      }
      case OP_RELEASE_TSFN: {
        const status = napi.napi_release_threadsafe_function(arg0 >>> 0, 0);
        return { status, value: 0 };
      }
      case OP_DRAIN: {
        // No-op: just letting the dispatcher tick.  By the time we get here
        // and reply, the host event loop has had a chance to run pending
        // setImmediates between RPC handler invocations.
        return { status: 0, value: 0 };
      }
      default:
        return { status: -1, value: 0 };
    }
  }

  // RPC server loop.
  let serving = true;
  parentPort.on("message", (m) => {
    if (m && m.kind === "shutdown") serving = false;
  });

  parentPort.postMessage({ kind: "ready", tsfnHandle });

  (async function serve() {
    let lastWake = 0;
    while (serving) {
      const r = Atomics.waitAsync(ctrl, SLOT_WAKE, lastWake, 500);
      if (r.async) {
        const v = await r.value;
        if (v === "timed-out") continue;
      }
      lastWake = Atomics.load(ctrl, SLOT_WAKE);

      // Drain pending request (just one at a time matching our test driver).
      if (Atomics.load(ctrl, SLOT_REQ) === 1) {
        const op = Atomics.load(ctrl, SLOT_OP);
        const arg0 = Atomics.load(ctrl, SLOT_ARG0);
        const arg1 = Atomics.load(ctrl, SLOT_ARG1);
        const arg2 = Atomics.load(ctrl, SLOT_ARG2);
        const { status, value } = dispatch(op, arg0, arg1, arg2);
        Atomics.store(ctrl, SLOT_REPSTATUS, status);
        Atomics.store(ctrl, SLOT_REPVAL, value >>> 0);
        Atomics.store(ctrl, SLOT_REP, 1);
        Atomics.store(ctrl, SLOT_REQ, 0);
        Atomics.notify(ctrl, SLOT_REP, 1);
      }
    }
  })();
}
