// E1 bundled-args-perf probe.
//
// Quantifies: cost of NAIVE callback dispatch (1 reverse + N forward + 1 reply)
// vs BUNDLED dispatch (1 reverse-with-args + 1 reply) at N = 1, 3, 5, 10.
//
// Roles:
//   main thread  = HOST (async drainer; owns "napi state"; fires callbacks).
//   worker       = WASM (sync; runs callback; in naive mode, calls back to host
//                  to inspect each arg).
//
// Two rings (each with a SAB request + SAB reply):
//   - "rev" ring: host -> wasm (callback fire) and wasm -> host (callback return).
//   - "fwd" ring: wasm -> host (napi arg inspection) and host -> wasm (arg value).
//
// One shared wake counter (single Int32 the WASM side Atomics.wait's on); both
// "host published reverse-req" and "host published forward-reply" notify it.
// Mirrors r1-reverse-during-forward layout.
//
// Modes:
//   NAIVE(N):    host fires reverse-req carrying just opcode+reqId+argCount.
//                wasm wakes, then issues N forward-RPCs (one per arg), each
//                returning an i32.  Then wasm publishes reverse-reply with
//                sum-of-args.  Total RPCs from wasm's POV: N forward + 1 reply.
//   BUNDLED(N):  host fires reverse-req with payload = [opcode, reqId, N, a0..a(N-1)].
//                wasm wakes, reads args from local payload, computes sum,
//                publishes reverse-reply.  Total RPCs: 1 reply.
//
// We measure HOST-side wall-time of one callback invocation (publish-reverse
// to receive-reverse-reply).  That covers the entire chain.
//
// Output: stats per (mode, N) and the naive/bundled ratio.

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";

// ── SAB layout (matches l5-sync-rpc / r1-reverse-during-forward).
const NUM_SLOTS = 8;
const SLOT_SIZE = 256;
const GH_SIZE = 16;
const SAB_SIZE = GH_SIZE + NUM_SLOTS * SLOT_SIZE;

const RING_WAKE_IDX = 0;
const SHARED_WAKE_IDX = 0;

const STATUS_EMPTY = 0;
const STATUS_WRITING = 1;
const STATUS_READY = 2;
const STATUS_READING = 3;

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

// `sharedWakeI32` is the WASM-side wake counter (wasm Atomics.wait's on it).
// `hostWakeI32` is the HOST-side wake counter (host Atomics.waitAsync's on it).
// Publishers bump BOTH so either side can be woken by either event type.
function publishAndNotifyShared(ringI32, slot, payloadLen, sharedWakeI32, hostWakeI32) {
  Atomics.store(ringI32, slotLenIdx(slot), payloadLen);
  Atomics.store(ringI32, slotStatusIdx(slot), STATUS_READY);
  Atomics.add(ringI32, RING_WAKE_IDX, 1);
  Atomics.notify(ringI32, RING_WAKE_IDX);
  Atomics.add(sharedWakeI32, SHARED_WAKE_IDX, 1);
  Atomics.notify(sharedWakeI32, SHARED_WAKE_IDX);
  Atomics.add(hostWakeI32, 0, 1);
  Atomics.notify(hostWakeI32, 0);
}

// Op codes
const OP_CB_NAIVE = 0xC1;    // reverse: fire callback; wasm will issue N forward RPCs
const OP_CB_BUNDLED = 0xC2;  // reverse: fire callback; args bundled in payload
const OP_NAPI_GET_ARG = 0xA1; // forward: get arg #i (returns i32 value)

// Iteration counts
const WARMUP = 50;
const ITERATIONS = 600;
const ARG_COUNTS = [1, 3, 5, 10];

if (isMainThread) {
  // SABs.
  const revReqSab = new SharedArrayBuffer(SAB_SIZE);
  const revRepSab = new SharedArrayBuffer(SAB_SIZE);
  const fwdReqSab = new SharedArrayBuffer(SAB_SIZE);
  const fwdRepSab = new SharedArrayBuffer(SAB_SIZE);
  const sharedWakeSab = new SharedArrayBuffer(64);
  const hostWakeSab = new SharedArrayBuffer(64);

  const revReqI32 = new Int32Array(revReqSab);
  const revRepI32 = new Int32Array(revRepSab);
  const fwdReqI32 = new Int32Array(fwdReqSab);
  const fwdRepI32 = new Int32Array(fwdRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);
  const hostWakeI32 = new Int32Array(hostWakeSab);

  const worker = new Worker(new URL(import.meta.url), {
    workerData: { revReqSab, revRepSab, fwdReqSab, fwdRepSab, sharedWakeSab, hostWakeSab },
  });
  worker.once("error", (e) => { console.error("[wasm]", e); process.exit(2); });

  let nextReqId = 1;
  function allocReqId() {
    const id = nextReqId++;
    if (nextReqId > 0xfffffff0) nextReqId = 1;
    return id;
  }

  // Per-iteration: state for the active callback.  Updated by host before each
  // invocation; consulted by the forward-request drainer.
  let activeArgs = null;

  // Drain incoming forward requests (wasm asking for arg values).  Sync handler;
  // looks up the requested arg in `activeArgs` and publishes a forward reply.
  function drainForwardRequests() {
    let drained = 0;
    for (let s = 0; s < NUM_SLOTS; s++) {
      const idx = slotStatusIdx(s);
      if (Atomics.compareExchange(fwdReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
      const start = slotPayloadStart(s);
      const dv = new DataView(fwdReqSab, start, 12);
      const opCode = dv.getUint32(0, true);
      const reqId  = dv.getUint32(4, true);
      const argIdx = dv.getUint32(8, true);
      freeSlotS(fwdReqI32, s);
      let result = 0;
      if (opCode === OP_NAPI_GET_ARG && activeArgs && argIdx < activeArgs.length) {
        result = activeArgs[argIdx] >>> 0;
      } else {
        result = 0xDEADBEEF >>> 0;
      }
      const repSlot = tryClaim(fwdRepI32);
      if (repSlot === -1) throw new Error("forward reply ring full");
      const rs = slotPayloadStart(repSlot);
      const rdv = new DataView(fwdRepSab, rs, 16);
      rdv.setUint32(0, opCode, true);
      rdv.setUint32(4, reqId, true);
      rdv.setUint32(8, 0, true); // status OK
      rdv.setUint32(12, result, true);
      publishAndNotifyShared(fwdRepI32, repSlot, 16, sharedWakeI32, hostWakeI32);
      drained++;
    }
    return drained;
  }

  // Fire a callback (reverse RPC), await the return.  In naive mode, while
  // we're awaiting we ALSO service forward requests from wasm.
  async function fireCallback(mode, args) {
    const reqId = allocReqId();
    const slot = tryClaim(revReqI32);
    if (slot === -1) throw new Error("reverse request ring full");
    const start = slotPayloadStart(slot);
    // Payload layout: [opCode u32, reqId u32, argCount u32, args... u32]
    const argCount = args.length;
    const payloadLen = 12 + (mode === "bundled" ? argCount * 4 : 0);
    const dv = new DataView(revReqSab, start, payloadLen);
    dv.setUint32(0, mode === "bundled" ? OP_CB_BUNDLED : OP_CB_NAIVE, true);
    dv.setUint32(4, reqId, true);
    dv.setUint32(8, argCount, true);
    if (mode === "bundled") {
      for (let i = 0; i < argCount; i++) {
        dv.setUint32(12 + i * 4, args[i] >>> 0, true);
      }
    }
    publishAndNotifyShared(revReqI32, slot, payloadLen, sharedWakeI32, hostWakeI32);

    const deadline = Date.now() + 5_000;
    let lastHostWake = Atomics.load(hostWakeI32, 0);
    while (Date.now() < deadline) {
      // Service forward requests from wasm (only relevant in naive mode).
      drainForwardRequests();
      // Check reverse-reply for our reqId.
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
      // Wait on the host-side wake counter — bumped by EITHER a forward request
      // or a reverse reply.
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      const r = Atomics.waitAsync(hostWakeI32, 0, lastHostWake, Math.min(remain, 1000));
      if (r.async) await r.value;
      lastHostWake = Atomics.load(hostWakeI32, 0);
    }
    throw new Error("reverse reply timeout");
  }

  // ── Run benchmarks.
  function pct(arr, p) {
    return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  }
  function fmt(n) { return n.toFixed(3); }

  async function bench(mode, n) {
    // Build args (just sequential ints; type marshalling not in scope).
    const args = Array.from({ length: n }, (_, i) => i + 1);
    activeArgs = args;
    const expected = args.reduce((a, b) => a + b, 0) >>> 0;

    // Warmup.
    for (let i = 0; i < WARMUP; i++) {
      const r = await fireCallback(mode, args);
      if (r !== expected) throw new Error(`warmup mismatch: got ${r}, want ${expected}`);
    }
    // Timed.
    const timings = new Float64Array(ITERATIONS);
    const totalT0 = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = process.hrtime.bigint();
      const r = await fireCallback(mode, args);
      const t1 = process.hrtime.bigint();
      timings[i] = Number(t1 - t0) / 1e3; // microseconds
      if (r !== expected) throw new Error(`iter ${i} mismatch: got ${r}, want ${expected}`);
    }
    const totalT1 = process.hrtime.bigint();
    const totalMs = Number(totalT1 - totalT0) / 1e6;
    const sorted = Array.from(timings).sort((a, b) => a - b);
    return {
      mode, n,
      min: sorted[0],
      median: pct(sorted, 0.5),
      p99: pct(sorted, 0.99),
      max: sorted[sorted.length - 1],
      totalMs,
      opsPerSec: (ITERATIONS / totalMs) * 1000,
    };
  }

  (async () => {
    // Give the worker a beat to initialize.
    await new Promise(r => setTimeout(r, 50));

    const results = [];
    for (const n of ARG_COUNTS) {
      const naive = await bench("naive", n);
      const bundled = await bench("bundled", n);
      results.push({ n, naive, bundled });
    }

    // Print table.
    console.log("");
    console.log("E1 bundled-args-perf — results");
    console.log(`(warmup=${WARMUP}, iterations=${ITERATIONS} per (mode,N); units=µs)`);
    console.log("");
    console.log("N    | mode    | min     | median  | p99     | max     | total ms | ops/sec");
    console.log("-----|---------|---------|---------|---------|---------|----------|--------");
    for (const r of results) {
      for (const k of ["naive", "bundled"]) {
        const x = r[k];
        console.log(
          `${String(r.n).padEnd(4)} | ${k.padEnd(7)} | ` +
          `${fmt(x.min).padStart(7)} | ${fmt(x.median).padStart(7)} | ${fmt(x.p99).padStart(7)} | ` +
          `${fmt(x.max).padStart(7)} | ${x.totalMs.toFixed(2).padStart(8)} | ${x.opsPerSec.toFixed(0).padStart(7)}`
        );
      }
    }
    console.log("");
    console.log("N    | naive_med | bundled_med | ratio | naive_p99 | bundled_p99 | ratio_p99");
    console.log("-----|-----------|-------------|-------|-----------|-------------|----------");
    for (const r of results) {
      const ratio = r.naive.median / r.bundled.median;
      const ratio99 = r.naive.p99 / r.bundled.p99;
      console.log(
        `${String(r.n).padEnd(4)} | ${fmt(r.naive.median).padStart(9)} | ${fmt(r.bundled.median).padStart(11)} | ` +
        `${ratio.toFixed(2).padStart(5)} | ${fmt(r.naive.p99).padStart(9)} | ${fmt(r.bundled.p99).padStart(11)} | ${ratio99.toFixed(2).padStart(8)}`
      );
    }
    console.log("");

    worker.postMessage("stop");
    setTimeout(() => process.exit(0), 100);
  })();
} else {
  // ── WASM worker: sync.  Waits for reverse requests; runs callback.
  const { revReqSab, revRepSab, fwdReqSab, fwdRepSab, sharedWakeSab, hostWakeSab } = workerData;
  const revReqI32 = new Int32Array(revReqSab);
  const revRepI32 = new Int32Array(revRepSab);
  const fwdReqI32 = new Int32Array(fwdReqSab);
  const fwdRepI32 = new Int32Array(fwdRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);
  const hostWakeI32 = new Int32Array(hostWakeSab);

  let nextFwdReqId = 1;
  function allocFwdReqId() {
    const id = nextFwdReqId++;
    if (nextFwdReqId > 0xfffffff0) nextFwdReqId = 1;
    return id;
  }

  // Sync forward RPC: ask host for arg #i, block until reply.
  function getArgSync(argIdx) {
    const reqId = allocFwdReqId();
    const slot = tryClaim(fwdReqI32);
    if (slot === -1) throw new Error("forward request ring full");
    const start = slotPayloadStart(slot);
    const dv = new DataView(fwdReqSab, start, 12);
    dv.setUint32(0, OP_NAPI_GET_ARG, true);
    dv.setUint32(4, reqId, true);
    dv.setUint32(8, argIdx, true);
    publishAndNotifyShared(fwdReqI32, slot, 12, sharedWakeI32, hostWakeI32);

    // Wait for fwd-reply.
    const deadline = Date.now() + 5_000;
    let lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
    while (Date.now() < deadline) {
      for (let s = 0; s < NUM_SLOTS; s++) {
        if (Atomics.load(fwdRepI32, slotStatusIdx(s)) !== STATUS_READY) continue;
        const ps = slotPayloadStart(s);
        const rdv = new DataView(fwdRepSab, ps, 16);
        const rid = rdv.getUint32(4, true);
        if (rid !== reqId) continue;
        const result = rdv.getUint32(12, true);
        freeSlotS(fwdRepI32, s);
        return result;
      }
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      Atomics.wait(sharedWakeI32, SHARED_WAKE_IDX, lastWake, Math.min(remain, 1000));
      lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
    }
    throw new Error("forward sync timeout");
  }

  let serving = true;
  parentPort.on("message", (m) => { if (m === "stop") serving = false; });

  // Sync loop: wait for reverse request, run callback, publish reverse reply.
  let lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
  while (serving) {
    // Drain reverse requests.
    for (let s = 0; s < NUM_SLOTS; s++) {
      const idx = slotStatusIdx(s);
      if (Atomics.compareExchange(revReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
      const start = slotPayloadStart(s);
      const dvHead = new DataView(revReqSab, start, 12);
      const opCode = dvHead.getUint32(0, true);
      const reqId  = dvHead.getUint32(4, true);
      const argCount = dvHead.getUint32(8, true);

      let sum = 0;
      if (opCode === OP_CB_NAIVE) {
        // Inspect each arg via forward RPC.
        for (let i = 0; i < argCount; i++) {
          sum = (sum + getArgSync(i)) >>> 0;
        }
      } else if (opCode === OP_CB_BUNDLED) {
        // Read all args from local payload (zero RPC).
        const dvArgs = new DataView(revReqSab, start + 12, argCount * 4);
        for (let i = 0; i < argCount; i++) {
          sum = (sum + dvArgs.getUint32(i * 4, true)) >>> 0;
        }
      } else {
        sum = 0xDEADBEEF >>> 0;
      }

      freeSlotS(revReqI32, s);

      // Publish reverse reply.
      const repSlot = tryClaim(revRepI32);
      if (repSlot === -1) throw new Error("reverse reply ring full");
      const rs = slotPayloadStart(repSlot);
      const rdv = new DataView(revRepSab, rs, 16);
      rdv.setUint32(0, opCode, true);
      rdv.setUint32(4, reqId, true);
      rdv.setUint32(8, 0, true);
      rdv.setUint32(12, sum, true);
      publishAndNotifyShared(revRepI32, repSlot, 16, sharedWakeI32, hostWakeI32);
    }

    // Wait for next reverse request (or stop).  Short timeout so we can
    // observe `serving` flips promptly.
    Atomics.wait(sharedWakeI32, SHARED_WAKE_IDX, lastWake, 200);
    lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
  }
}
