// F-3 sync-RPC probe.
// Validates: a sync caller can issue an RPC + Atomics.wait for reply,
// while a host runs async drainer + serves the request.

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";

const NUM_SLOTS = 8;
const SLOT_SIZE = 256; // bytes
const GH_SIZE = 16;
const SAB_SIZE = GH_SIZE + NUM_SLOTS * SLOT_SIZE;
const WAKE_IDX = 0;
const STATUS_EMPTY = 0;
const STATUS_WRITING = 1;
const STATUS_READY = 2;
const STATUS_READING = 3;

function slotStatusIdx(slot) { return (GH_SIZE + slot * SLOT_SIZE) >>> 2; }
function slotPayloadStart(slot) { return GH_SIZE + slot * SLOT_SIZE + 16; } // 16-byte slot header

function tryClaim(i32) {
  for (let s = 0; s < NUM_SLOTS; s++) {
    const idx = slotStatusIdx(s);
    if (Atomics.compareExchange(i32, idx, STATUS_EMPTY, STATUS_WRITING) === STATUS_EMPTY) return s;
  }
  return -1;
}

function publish(i32, slot, payloadLen) {
  // payloadLen at slot+12
  const lenIdx = (GH_SIZE + slot * SLOT_SIZE + 12) >>> 2;
  Atomics.store(i32, lenIdx, payloadLen);
  Atomics.store(i32, slotStatusIdx(slot), STATUS_READY);
  Atomics.add(i32, WAKE_IDX, 1);
  Atomics.notify(i32, WAKE_IDX, 1);
}

function freeS(i32, slot) {
  Atomics.store(i32, slotStatusIdx(slot), STATUS_EMPTY);
}

if (isMainThread) {
  const reqSab = new SharedArrayBuffer(SAB_SIZE);
  const repSab = new SharedArrayBuffer(SAB_SIZE);
  const reqI32 = new Int32Array(reqSab);
  const repI32 = new Int32Array(repSab);
  const repU8 = new Uint8Array(repSab);
  const reqU8 = new Uint8Array(reqSab);

  const worker = new Worker(new URL(import.meta.url), { workerData: { reqSab, repSab } });
  worker.once("error", (e) => { console.error("[main]", e); process.exit(2); });

  // Async drainer: process incoming requests, write replies.
  let lastWake = 0;
  let serving = true;
  worker.on("message", (m) => {
    if (m === "done") {
      serving = false;
      worker.terminate();
      console.log("[main] sync RPC probe: OK");
      process.exit(0);
    } else if (m === "fail") {
      console.log("[main] sync RPC probe: FAIL");
      process.exit(1);
    }
  });
  (async function serve() {
    while (serving) {
      // Wait for new requests.
      const result = Atomics.waitAsync(reqI32, WAKE_IDX, lastWake, 5_000);
      if (result.async) await result.value;
      lastWake = Atomics.load(reqI32, WAKE_IDX);
      // Drain ready slots.
      for (let slot = 0; slot < NUM_SLOTS; slot++) {
        const idx = slotStatusIdx(slot);
        if (Atomics.compareExchange(reqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
        // Read request: opCode (u32) + requestId (u32) + args
        const start = slotPayloadStart(slot);
        const opCode = (new DataView(reqSab, start, 4)).getUint32(0, true);
        const requestId = (new DataView(reqSab, start + 4, 4)).getUint32(0, true);
        // Args: 2 u32s
        const a = (new DataView(reqSab, start + 8, 4)).getUint32(0, true);
        const b = (new DataView(reqSab, start + 12, 4)).getUint32(0, true);
        const result = a + b; // host "computes"
        // Free the request slot.
        freeS(reqI32, slot);
        // Write reply: opCode + requestId + status + result.
        const repSlot = tryClaim(repI32);
        if (repSlot === -1) { console.log("[main] reply ring full!"); continue; }
        const repStart = slotPayloadStart(repSlot);
        (new DataView(repSab, repStart, 4)).setUint32(0, opCode, true);
        (new DataView(repSab, repStart + 4, 4)).setUint32(0, requestId, true);
        (new DataView(repSab, repStart + 8, 4)).setUint32(0, 0 /*REPLY_STATUS_OK*/, true);
        (new DataView(repSab, repStart + 12, 4)).setUint32(0, result, true);
        publish(repI32, repSlot, 16); // 12-byte reply header + 4-byte result
      }
    }
  })();
} else {
  const { reqSab, repSab } = workerData;
  const reqI32 = new Int32Array(reqSab);
  const repI32 = new Int32Array(repSab);
  const repU8 = new Uint8Array(repSab);

  // Sync caller: write request, then Atomics.wait for reply.
  function syncCall(opCode, a, b) {
    const requestId = Math.floor(Math.random() * 1e9);
    const slot = tryClaim(reqI32);
    if (slot === -1) throw new Error("request ring full");
    const start = slotPayloadStart(slot);
    (new DataView(reqSab, start, 4)).setUint32(0, opCode, true);
    (new DataView(reqSab, start + 4, 4)).setUint32(0, requestId, true);
    (new DataView(reqSab, start + 8, 4)).setUint32(0, a, true);
    (new DataView(reqSab, start + 12, 4)).setUint32(0, b, true);
    publish(reqI32, slot, 16);
    // Wait for reply with matching requestId.
    const deadline = Date.now() + 5_000;
    let lastWake = Atomics.load(repI32, WAKE_IDX);
    while (Date.now() < deadline) {
      for (let s = 0; s < NUM_SLOTS; s++) {
        const idx = slotStatusIdx(s);
        if (Atomics.load(repI32, idx) !== STATUS_READY) continue;
        const ps = slotPayloadStart(s);
        const rid = (new DataView(repSab, ps + 4, 4)).getUint32(0, true);
        if (rid !== requestId) continue;
        const result = (new DataView(repSab, ps + 12, 4)).getUint32(0, true);
        freeS(repI32, s);
        return result;
      }
      Atomics.wait(repI32, WAKE_IDX, lastWake, 1_000);
      lastWake = Atomics.load(repI32, WAKE_IDX);
    }
    throw new Error("sync call timeout");
  }

  try {
    // SYNC calls — block this worker's JS thread.  No event loop turns.
    for (let i = 0; i < 100; i++) {
      const r = syncCall(0x1234, i, i * 2);
      if (r !== i + i * 2) {
        console.log(`[worker] iter ${i}: expected ${i + i * 2}, got ${r}`);
        parentPort.postMessage("fail");
        process.exit(1);
      }
    }
    console.log("[worker] 100 sync RPC calls all returned correct sums");
    parentPort.postMessage("done");
  } catch (e) {
    console.log("[worker] error:", e.message);
    parentPort.postMessage("fail");
    process.exit(1);
  }
}
