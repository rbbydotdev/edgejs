// R4 — quantify boot-time inflation from routing every napi op via SAB-RPC.
//
// Topology mirrors production:
//   - Worker thread (= wasm runtime worker): sync caller. Writes request,
//     Atomics.wait for reply. Uses Atomics.wait (blocking) — exactly like
//     SyncRpcClient in browser-target/src/host-worker/rpc-client-sync.ts.
//   - Main thread (= host worker): async drainer. Atomics.waitAsync for
//     requests, dispatches, writes reply, notifies.
//
// Methodology:
//   - Stress-mode sync RPC loop in worker.
//   - Iterations: 10k, 50k, 100k.
//   - Payload sizes: 8B, 32B, 128B.
//   - Records per-call RTT in Float64Array; computes p50/p99/p999/mean.
//   - In-process "noop" baseline: same dispatch logic as a local JS function,
//     no SAB / atomics / worker hop. Gives the ratio.
//
// Output: numbers per (iters × payload) plus baseline + projections.
//
// Code style: based directly on experiments/l5-sync-rpc/probe.mjs which is
// the validated F-3 spike. Stayed close to that ring layout (NUM_SLOTS,
// SLOT_SIZE, GH_SIZE) so behavior matches production sab-ring as closely
// as the L5 probe does.

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";

// Ring layout — matches l5-sync-rpc exactly so behavior matches.
const NUM_SLOTS = 8;
const SLOT_SIZE = 256; // bytes — payload up to 256 - 16 (slot header) = 240
const GH_SIZE = 16;    // wake counter @ idx 0
const SAB_SIZE = GH_SIZE + NUM_SLOTS * SLOT_SIZE;
const WAKE_IDX = 0;
const STATUS_EMPTY = 0;
const STATUS_WRITING = 1;
const STATUS_READY = 2;
const STATUS_READING = 3;

function slotStatusIdx(slot) { return (GH_SIZE + slot * SLOT_SIZE) >>> 2; }
function slotPayloadStart(slot) { return GH_SIZE + slot * SLOT_SIZE + 16; }

function tryClaim(i32) {
  for (let s = 0; s < NUM_SLOTS; s++) {
    const idx = slotStatusIdx(s);
    if (Atomics.compareExchange(i32, idx, STATUS_EMPTY, STATUS_WRITING) === STATUS_EMPTY) return s;
  }
  return -1;
}
function publish(i32, slot, payloadLen) {
  const lenIdx = (GH_SIZE + slot * SLOT_SIZE + 12) >>> 2;
  Atomics.store(i32, lenIdx, payloadLen);
  Atomics.store(i32, slotStatusIdx(slot), STATUS_READY);
  Atomics.add(i32, WAKE_IDX, 1);
  Atomics.notify(i32, WAKE_IDX, 1);
}
function freeS(i32, slot) {
  Atomics.store(i32, slotStatusIdx(slot), STATUS_EMPTY);
}

// Bench config.
const PAYLOAD_SIZES = [8, 32, 128];
const ITERATIONS    = [10_000, 50_000, 100_000];
const WARMUP_ITERS  = 1_000;

function percentile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(p * sortedArr.length)));
  return sortedArr[idx];
}
function fmtUs(ns) { return (ns / 1000).toFixed(2) + " µs"; }
function fmtMs(ns) { return (ns / 1e6).toFixed(2) + " ms"; }

if (isMainThread) {
  const reqSab = new SharedArrayBuffer(SAB_SIZE);
  const repSab = new SharedArrayBuffer(SAB_SIZE);
  const reqI32 = new Int32Array(reqSab);
  const repI32 = new Int32Array(repSab);
  const reqU8 = new Uint8Array(reqSab);

  const worker = new Worker(new URL(import.meta.url), { workerData: { reqSab, repSab } });
  worker.once("error", (e) => { console.error("[host]", e); process.exit(2); });

  let serving = true;
  worker.on("message", (m) => {
    if (m === "done") {
      console.error("[host] worker reported done");
      serving = false;
      // Don't terminate — let worker exit naturally so stdout flushes.
    } else if (typeof m === "object" && m.kind === "fail") {
      console.error("[host] worker reported failure:", m);
      serving = false;
    }
  });
  worker.on("exit", (code) => {
    console.error(`[host] worker exited with code ${code}`);
    process.exit(code);
  });

  // Async drainer — same shape as l5-sync-rpc/probe.mjs serve().
  let lastWake = 0;
  (async function serve() {
    while (serving) {
      const result = Atomics.waitAsync(reqI32, WAKE_IDX, lastWake, 5_000);
      if (result.async) await result.value;
      lastWake = Atomics.load(reqI32, WAKE_IDX);
      // Drain ready request slots.
      for (let slot = 0; slot < NUM_SLOTS; slot++) {
        const idx = slotStatusIdx(slot);
        if (Atomics.compareExchange(reqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
        const start = slotPayloadStart(slot);
        const opCode    = (new DataView(reqSab, start, 4)).getUint32(0, true);
        const requestId = (new DataView(reqSab, start + 4, 4)).getUint32(0, true);
        // Cheap "dispatch": touch first 4 payload bytes (after the 8-byte
        // header). Forces a shared-memory read — mirrors what a real napi
        // handler does when reading args.
        let work = 0;
        work = reqU8[start + 8] + reqU8[start + 9] + reqU8[start + 10] + reqU8[start + 11];
        freeS(reqI32, slot);

        // Write reply: [opCode][requestId][status][result]  (16 bytes total).
        const repSlot = tryClaim(repI32);
        if (repSlot === -1) { console.error("[host] reply ring full!"); continue; }
        const repStart = slotPayloadStart(repSlot);
        (new DataView(repSab, repStart, 4)).setUint32(0, opCode, true);
        (new DataView(repSab, repStart + 4, 4)).setUint32(0, requestId, true);
        (new DataView(repSab, repStart + 8, 4)).setUint32(0, 0, true);     // status OK
        (new DataView(repSab, repStart + 12, 4)).setUint32(0, work, true);
        publish(repI32, repSlot, 16);
      }
    }
  })();
} else {
  // ── Worker (sync caller) ──────────────────────────────────────────────
  const { reqSab, repSab } = workerData;
  const reqI32 = new Int32Array(reqSab);
  const repI32 = new Int32Array(repSab);
  const reqU8 = new Uint8Array(reqSab);

  // Sync RPC: write request, block on Atomics.wait for matching reply.
  function syncCall(opCode, requestId, payloadBuf) {
    let slot = tryClaim(reqI32);
    if (slot === -1) throw new Error("request ring full");
    const start = slotPayloadStart(slot);
    (new DataView(reqSab, start, 4)).setUint32(0, opCode, true);
    (new DataView(reqSab, start + 4, 4)).setUint32(0, requestId, true);
    // Copy payload after the 8-byte header.  Bounds: payloadBuf.byteLength <= 240.
    if (payloadBuf.byteLength > 0) {
      reqU8.set(payloadBuf, start + 8);
    }
    const totalLen = 8 + payloadBuf.byteLength;
    publish(reqI32, slot, totalLen);

    const deadline = Date.now() + 30_000;
    let lastWake = Atomics.load(repI32, WAKE_IDX);
    while (Date.now() < deadline) {
      for (let s = 0; s < NUM_SLOTS; s++) {
        if (Atomics.load(repI32, slotStatusIdx(s)) !== STATUS_READY) continue;
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

  // In-process baseline: same dispatch logic, no SAB / atomics / worker hop.
  function inProcCall(opCode, requestId, payloadBuf) {
    // Mirror the host's "work": touch first 4 bytes.
    let work = 0;
    if (payloadBuf.byteLength >= 4) {
      work = payloadBuf[0] + payloadBuf[1] + payloadBuf[2] + payloadBuf[3];
    }
    return work;
  }

  function runBench({ iters, payloadBytes, label, fn }) {
    const payload = new Uint8Array(payloadBytes);
    for (let i = 0; i < payloadBytes; i++) payload[i] = (i * 31 + 7) & 0xff;

    // Warmup — drives JIT and pre-claims a slot path.
    for (let i = 0; i < Math.min(WARMUP_ITERS, iters); i++) {
      fn(0x100 + (i & 0xff), 0xC0000000 + i, payload);
    }

    const rtts = new Float64Array(iters);
    const wallStart = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      const t0 = process.hrtime.bigint();
      fn(0x100 + (i & 0xff), 1 + i, payload);
      const t1 = process.hrtime.bigint();
      rtts[i] = Number(t1 - t0);
    }
    const wallEnd = process.hrtime.bigint();
    const wallNs = Number(wallEnd - wallStart);

    const sorted = Float64Array.from(rtts).sort();
    const p50 = percentile(sorted, 0.50);
    const p99 = percentile(sorted, 0.99);
    const p999 = percentile(sorted, 0.999);
    let sum = 0; for (let i = 0; i < sorted.length; i++) sum += sorted[i];
    const mean = sum / sorted.length;
    return { label, iters, payloadBytes, p50, p99, p999, mean, wallNs };
  }

  try {
    console.log(`\n── R4: SAB-RPC boot-overhead probe ─────────────────────────────`);
    console.log(`NUM_SLOTS=${NUM_SLOTS}, SLOT_SIZE=${SLOT_SIZE}B, warmup=${WARMUP_ITERS}\n`);

    // Smoke: validate the rig with 5 calls before stressing.
    const smokePayload = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0, 0, 0, 0]);
    const expected = 0xAA + 0xBB + 0xCC + 0xDD;
    for (let i = 0; i < 5; i++) {
      const r = syncCall(0x999, 1000 + i, smokePayload);
      if (r !== expected) {
        throw new Error(`smoke iter ${i}: expected ${expected}, got ${r}`);
      }
    }
    console.log("[smoke] 5 calls OK\n");

    // 1) In-process baseline.
    const baseline = runBench({
      iters: 100_000,
      payloadBytes: 32,
      label: "in-process noop",
      fn: inProcCall,
    });
    console.log(`[baseline ${baseline.label} 32B × ${baseline.iters}]\n`);
    console.log(`  p50=${fmtUs(baseline.p50)}  p99=${fmtUs(baseline.p99)}  mean=${fmtUs(baseline.mean)}  wall=${fmtMs(baseline.wallNs)}\n\n`);

    // 2) SAB-RPC stress matrix.
    const results = [];
    for (const payloadBytes of PAYLOAD_SIZES) {
      for (const iters of ITERATIONS) {
        const r = runBench({ iters, payloadBytes, label: "sab-rpc", fn: syncCall });
        results.push(r);
        const perCall = r.wallNs / r.iters;
        const msPer1k = (perCall * 1000) / 1e6;
        console.log(`[sab-rpc ${payloadBytes}B × ${iters}]\n`);
        console.log(`  p50=${fmtUs(r.p50)}  p99=${fmtUs(r.p99)}  p999=${fmtUs(r.p999)}  mean=${fmtUs(r.mean)}\n`);
        console.log(`  wall=${fmtMs(r.wallNs)}  per-call=${fmtUs(perCall)}  per-1k=${msPer1k.toFixed(2)}ms\n`);
      }
    }

    // 3) Projections — use the 100k-iter averages across payload sizes
    //    as the "realistic" steady-state per-call cost.
    const ref = results.filter(r => r.iters === 100_000);
    const refP50Mean = ref.reduce((a, b) => a + b.p50, 0) / ref.length;
    const refPerCall = ref.reduce((a, b) => a + (b.wallNs / b.iters), 0) / ref.length;

    console.log(`\n── Projections ─────────────────────────────────────────────────\n`);
    console.log(`Reference per-call wall-time (avg over 100k, all payloads): ${fmtUs(refPerCall)}\n`);
    console.log(`Reference p50 RTT:                                          ${fmtUs(refP50Mean)}\n`);
    for (const callCount of [10_000, 20_000, 50_000, 100_000]) {
      const projNs = refPerCall * callCount;
      console.log(`  ${callCount.toString().padStart(7)} napi calls → ${fmtMs(projNs)} added boot time\n`);
    }
    const ratio = refPerCall / baseline.mean;
    console.log(`\nRTT-vs-inproc ratio: ~${ratio.toFixed(0)}x slower per call\n`);

    parentPort.postMessage("done");
  } catch (e) {
    console.log(`[worker] error: ${e && e.stack || e}\n`);
    parentPort.postMessage({ kind: "fail", message: String(e) });
    process.exit(1);
  }
}
