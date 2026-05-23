// R1 reverse-during-forward probe.
//
// Validates: while wasm is Atomics.wait-blocked on a forward RPC reply,
// host can send a REVERSE RPC request that wakes wasm; wasm processes
// the reverse, publishes a reverse reply, then re-enters Atomics.wait
// for the original forward reply.
//
// Layout:
//   - 4 rings (request + reply for both directions): forward-req, forward-rep,
//     reverse-req, reverse-rep.
//   - 1 dedicated wake SAB (single Int32) — both "host publishes forward
//     reply" and "host publishes reverse request" notify this single
//     address.  Wasm Atomics.wait's on it.
//
// Roles:
//   - main thread plays "wasm worker" — sync RPC caller.
//   - worker thread plays "host worker" — async drainer + reverse client.
//
// Test op:
//   - Forward op: doubleBytes(arr) — host wants wasm to do the doubling.
//     Host receives forward(arr), issues reverse(doubleEcho, arr),
//     waits for reverse reply, then returns forward reply = reverse result.
//   - So the forward result == arr doubled, computed BY WASM, via reverse.

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";

// ── SAB ring layout (matches l5-sync-rpc/probe.mjs).
const NUM_SLOTS = 8;
const SLOT_SIZE = 256;
const GH_SIZE = 16; // global header (we re-use index 0 as a per-ring wake counter, but we ALSO have the shared wake SAB).
const SAB_SIZE = GH_SIZE + NUM_SLOTS * SLOT_SIZE;

// Per-ring (legacy) wake counter index; kept for ring's own bookkeeping but
// the SHARED wake counter is what wasm waits on.
const RING_WAKE_IDX = 0;

const STATUS_EMPTY = 0;
const STATUS_WRITING = 1;
const STATUS_READY = 2;
const STATUS_READING = 3;

// Shared wake SAB — single Int32 that BOTH directions notify.
const SHARED_WAKE_IDX = 0;

function slotStatusIdx(slot) { return (GH_SIZE + slot * SLOT_SIZE) >>> 2; }
function slotLenIdx(slot)    { return (GH_SIZE + slot * SLOT_SIZE + 12) >>> 2; }
function slotPayloadStart(slot) { return GH_SIZE + slot * SLOT_SIZE + 16; }

function tryClaim(i32) {
  for (let s = 0; s < NUM_SLOTS; s++) {
    const idx = slotStatusIdx(s);
    if (Atomics.compareExchange(i32, idx, STATUS_EMPTY, STATUS_WRITING) === STATUS_EMPTY) return s;
  }
  return -1;
}

function freeSlotS(i32, slot) {
  Atomics.store(i32, slotStatusIdx(slot), STATUS_EMPTY);
}

// Publish a slot and notify the SHARED wake counter.
function publishAndNotifyShared(ringI32, slot, payloadLen, sharedWakeI32) {
  Atomics.store(ringI32, slotLenIdx(slot), payloadLen);
  Atomics.store(ringI32, slotStatusIdx(slot), STATUS_READY);
  // Bump the per-ring wake counter (useful for the async side using waitAsync).
  Atomics.add(ringI32, RING_WAKE_IDX, 1);
  Atomics.notify(ringI32, RING_WAKE_IDX);
  // ALSO bump the SHARED wake counter — this is what wasm waits on.
  Atomics.add(sharedWakeI32, SHARED_WAKE_IDX, 1);
  Atomics.notify(sharedWakeI32, SHARED_WAKE_IDX);
}

// ────────────────────────────────────────────────────────────────────
// Op codes / payload helpers
// Forward op: FWD_DOUBLE — payload is a Uint32 N; host echoes 2*N
// (but via reverse callback to wasm).
// Reverse op: REV_DOUBLE — payload is a Uint32 N; wasm returns 2*N.
const OP_FWD_DOUBLE = 0xF1;
const OP_REV_DOUBLE = 0xB1;

if (isMainThread) {
  // Allocate SABs.
  const fwdReqSab = new SharedArrayBuffer(SAB_SIZE);
  const fwdRepSab = new SharedArrayBuffer(SAB_SIZE);
  const revReqSab = new SharedArrayBuffer(SAB_SIZE);
  const revRepSab = new SharedArrayBuffer(SAB_SIZE);
  const sharedWakeSab = new SharedArrayBuffer(64); // 16 Int32s is plenty; only [0] is used.

  const fwdReqI32 = new Int32Array(fwdReqSab);
  const fwdRepI32 = new Int32Array(fwdRepSab);
  const revReqI32 = new Int32Array(revReqSab);
  const revRepI32 = new Int32Array(revRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);

  // Spawn host worker.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab },
  });
  worker.once("error", (e) => { console.error("[host]", e); process.exit(2); });
  worker.once("exit", (code) => {
    if (code !== 0) {
      console.error(`[host] exited with code ${code}`);
      process.exit(code || 1);
    }
  });

  // ── "Wasm" side: sync RPC caller.
  //
  // sendForward(N):
  //   1. Claim fwd-req slot, write [opCode, reqId, N], publish → bumps shared wake.
  //   2. Loop: Atomics.wait on shared wake address.
  //   3. On wake, FIRST poll reverse-request ring; if a reverse is ready, process
  //      it (compute 2*N), publish reverse-reply, continue waiting.
  //   4. THEN poll forward-reply ring; if our reply is ready, return it.
  function sendForwardSync(opCode, n) {
    const requestId = (Math.random() * 0xfffffff0) >>> 0;
    const slot = tryClaim(fwdReqI32);
    if (slot === -1) throw new Error("forward request ring full");
    const start = slotPayloadStart(slot);
    const dv = new DataView(fwdReqSab, start, 16);
    dv.setUint32(0, opCode, true);
    dv.setUint32(4, requestId, true);
    dv.setUint32(8, n, true);
    publishAndNotifyShared(fwdReqI32, slot, 12, sharedWakeI32);

    const deadline = Date.now() + 5_000;
    let lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
    while (Date.now() < deadline) {
      // 1. Drain reverse requests FIRST (priority).
      drainReverseRequests();

      // 2. Check forward-reply ring for our requestId.
      for (let s = 0; s < NUM_SLOTS; s++) {
        const idx = slotStatusIdx(s);
        if (Atomics.load(fwdRepI32, idx) !== STATUS_READY) continue;
        const ps = slotPayloadStart(s);
        const rid = new DataView(fwdRepSab, ps + 4, 4).getUint32(0, true);
        if (rid !== requestId) continue;
        const result = new DataView(fwdRepSab, ps + 12, 4).getUint32(0, true);
        freeSlotS(fwdRepI32, s);
        return result;
      }

      // 3. Wait on shared wake address.  Either fwd reply or rev request will wake us.
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      const r = Atomics.wait(sharedWakeI32, SHARED_WAKE_IDX, lastWake, Math.min(remain, 1_000));
      lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
      void r;
    }
    throw new Error(`forward sync call timeout reqId=${requestId}`);
  }

  // Drain any pending reverse requests.  Sync handler: compute, publish reply.
  function drainReverseRequests() {
    for (let s = 0; s < NUM_SLOTS; s++) {
      const idx = slotStatusIdx(s);
      if (Atomics.compareExchange(revReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
      const start = slotPayloadStart(s);
      const dv = new DataView(revReqSab, start, 12);
      const opCode = dv.getUint32(0, true);
      const reqId  = dv.getUint32(4, true);
      const n      = dv.getUint32(8, true);
      // Compute reverse result (this is "wasm" doing the callback work).
      let result = 0;
      if (opCode === OP_REV_DOUBLE) {
        result = (n * 2) >>> 0;
      } else {
        // Unknown reverse op.
        result = 0xDEADBEEF >>> 0;
      }
      // Free the reverse request slot.
      freeSlotS(revReqI32, s);
      // Publish reverse reply.
      const repSlot = tryClaim(revRepI32);
      if (repSlot === -1) throw new Error("reverse reply ring full");
      const rs = slotPayloadStart(repSlot);
      const rdv = new DataView(revRepSab, rs, 16);
      rdv.setUint32(0, opCode, true);
      rdv.setUint32(4, reqId, true);
      rdv.setUint32(8, 0, true); // status OK
      rdv.setUint32(12, result, true);
      publishAndNotifyShared(revRepI32, repSlot, 16, sharedWakeI32);
    }
  }

  // ── Run the experiment.
  const ITERATIONS = 1000;
  const timings = [];

  let allOk = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    const expected = (i * 2) >>> 0;
    let result;
    try {
      result = sendForwardSync(OP_FWD_DOUBLE, i);
    } catch (e) {
      console.error(`[wasm] iter ${i} threw:`, e.message);
      allOk = false;
      break;
    }
    const t1 = process.hrtime.bigint();
    timings.push(Number(t1 - t0) / 1e6); // ms
    if (result !== expected) {
      console.error(`[wasm] iter ${i}: expected ${expected}, got ${result}`);
      allOk = false;
      break;
    }
  }

  // Sort timings, compute stats.
  timings.sort((a, b) => a - b);
  const sum = timings.reduce((a, b) => a + b, 0);
  const mean = sum / timings.length;
  const median = timings[Math.floor(timings.length / 2)];
  const p99 = timings[Math.floor(timings.length * 0.99)];
  const p999 = timings[Math.floor(timings.length * 0.999)];
  const min = timings[0];
  const max = timings[timings.length - 1];

  console.log(`[wasm] ${ITERATIONS} reverse-during-forward roundtrips: ${allOk ? "PASS" : "FAIL"}`);
  console.log(`[wasm] timings ms: min=${min.toFixed(3)} median=${median.toFixed(3)} mean=${mean.toFixed(3)} p99=${p99.toFixed(3)} p999=${p999.toFixed(3)} max=${max.toFixed(3)}`);

  // Tell host worker we're done.
  worker.postMessage("stop");
  setTimeout(() => process.exit(allOk ? 0 : 1), 100);
} else {
  // ── HOST worker: async drainer.  Receives forward requests, issues
  //    reverse RPC, awaits reverse reply, then publishes forward reply.
  const { fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab } = workerData;
  const fwdReqI32 = new Int32Array(fwdReqSab);
  const fwdRepI32 = new Int32Array(fwdRepSab);
  const revReqI32 = new Int32Array(revReqSab);
  const revRepI32 = new Int32Array(revRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);

  let nextRevId = 1;
  function allocRevId() {
    const id = nextRevId++;
    if (nextRevId > 0xfffffff0) nextRevId = 1;
    return id;
  }

  // Send a reverse request to wasm, await reverse reply asynchronously.
  // Uses waitAsync — host is on its own event loop and can.
  async function callReverse(opCode, n) {
    const reqId = allocRevId();
    const slot = tryClaim(revReqI32);
    if (slot === -1) throw new Error("reverse request ring full");
    const start = slotPayloadStart(slot);
    const dv = new DataView(revReqSab, start, 12);
    dv.setUint32(0, opCode, true);
    dv.setUint32(4, reqId, true);
    dv.setUint32(8, n, true);
    publishAndNotifyShared(revReqI32, slot, 12, sharedWakeI32);

    // Now wait (async) for the reverse-reply ring to have a matching slot.
    const deadline = Date.now() + 5_000;
    // Use the per-ring wake counter on revRepI32 (host can use waitAsync here).
    let lastWake = Atomics.load(revRepI32, RING_WAKE_IDX);
    while (Date.now() < deadline) {
      for (let s = 0; s < NUM_SLOTS; s++) {
        if (Atomics.load(revRepI32, slotStatusIdx(s)) !== STATUS_READY) continue;
        const ps = slotPayloadStart(s);
        const rdv = new DataView(revRepSab, ps, 16);
        const rid = rdv.getUint32(4, true);
        if (rid !== reqId) continue;
        const result = rdv.getUint32(12, true);
        freeSlotS(revRepI32, s);
        return result;
      }
      const r = Atomics.waitAsync(revRepI32, RING_WAKE_IDX, lastWake, 1_000);
      if (r.async) await r.value;
      lastWake = Atomics.load(revRepI32, RING_WAKE_IDX);
    }
    throw new Error("reverse reply timeout");
  }

  // Async forward drainer.
  let serving = true;
  parentPort.on("message", (m) => { if (m === "stop") serving = false; });

  (async function serve() {
    let lastWake = Atomics.load(fwdReqI32, RING_WAKE_IDX);
    while (serving) {
      // Drain forward requests.
      for (let s = 0; s < NUM_SLOTS; s++) {
        const idx = slotStatusIdx(s);
        if (Atomics.compareExchange(fwdReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
        const start = slotPayloadStart(s);
        const dv = new DataView(fwdReqSab, start, 12);
        const opCode = dv.getUint32(0, true);
        const reqId  = dv.getUint32(4, true);
        const n      = dv.getUint32(8, true);
        freeSlotS(fwdReqI32, s);

        // Process forward op by CALLING BACK INTO WASM via reverse RPC.
        // While we await reverse reply, wasm is Atomics.wait-blocked on
        // the shared wake.  Our publishAndNotifyShared inside callReverse
        // is what wakes it.
        let result;
        if (opCode === OP_FWD_DOUBLE) {
          // Ask wasm to double it (the whole point of this experiment).
          result = await callReverse(OP_REV_DOUBLE, n);
        } else {
          result = 0xDEADBEEF >>> 0;
        }

        // Publish forward reply.
        const repSlot = tryClaim(fwdRepI32);
        if (repSlot === -1) {
          console.error("[host] forward reply ring full");
          continue;
        }
        const rs = slotPayloadStart(repSlot);
        const rdv = new DataView(fwdRepSab, rs, 16);
        rdv.setUint32(0, opCode, true);
        rdv.setUint32(4, reqId, true);
        rdv.setUint32(8, 0, true);
        rdv.setUint32(12, result, true);
        publishAndNotifyShared(fwdRepI32, repSlot, 16, sharedWakeI32);
      }

      // Wait for more forward requests.
      const r = Atomics.waitAsync(fwdReqI32, RING_WAKE_IDX, lastWake, 1_000);
      if (r.async) await r.value;
      lastWake = Atomics.load(fwdReqI32, RING_WAKE_IDX);
    }
  })();
}
