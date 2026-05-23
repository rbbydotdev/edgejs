// E4: realistic-callback end-to-end latency probe.
//
// Models the full Lever-B cutover RPC shape for ONE napi callback fire:
//
//   1. JS code on host calls `someJsFunction(1, "hello", 3.14)`.
//      → host's JS closure wraps a wasm funcref idx.
//   2. Host issues a REVERSE RPC `REV_INVOKE_CB(funcrefIdx, args...)` into wasm.
//   3. Wasm worker (blocked in Atomics.wait) wakes, dispatches funcref.
//   4. Funcref body inspects 3 args:
//        NAIVE  — issues 3 forward sync RPCs (napi_get_value_int32 / string / double).
//        BUNDLED — args already inlined in reverse-RPC payload; no forward RPCs.
//   5. Funcref returns; wasm publishes reverse-reply.
//   6. Host's wrapper resumes, returns to JS caller.
//
// Compared to:
//   • IN-PROCESS BASELINE — same callback body called as a normal JS function.
//
// Probe layout (mirrors r1-reverse-during-forward / r6-nested-sync-rpc):
//   • main thread  = "wasm worker" (sync RPC caller, drains reverse requests).
//   • worker thread = "host"        (async drainer; sends reverse RPCs).
//
// To measure host→callback→host END-TO-END, the *host* worker times each
// invocation around its `callReverse(...)` call and ships timings back via
// `parentPort.postMessage` at the end. Main-thread Math wakes wasm side
// (work + 3 nested forward RPCs in naive mode).

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";

// ── SAB ring layout (identical to r1/r6). ────────────────────────────
const NUM_SLOTS = 8;
const SLOT_SIZE = 512;           // bumped a bit — bundled payload up to ~96B + headers.
const GH_SIZE   = 16;
const SAB_SIZE  = GH_SIZE + NUM_SLOTS * SLOT_SIZE;
const RING_WAKE_IDX = 0;
const SHARED_WAKE_IDX = 0;
const STATUS_EMPTY = 0, STATUS_WRITING = 1, STATUS_READY = 2, STATUS_READING = 3;

function slotStatusIdx(slot)    { return (GH_SIZE + slot * SLOT_SIZE) >>> 2; }
function slotLenIdx(slot)       { return (GH_SIZE + slot * SLOT_SIZE + 12) >>> 2; }
function slotPayloadStart(slot) { return GH_SIZE + slot * SLOT_SIZE + 16; }

function tryClaim(i32) {
  for (let s = 0; s < NUM_SLOTS; s++) {
    const idx = slotStatusIdx(s);
    if (Atomics.compareExchange(i32, idx, STATUS_EMPTY, STATUS_WRITING) === STATUS_EMPTY) return s;
  }
  return -1;
}
function freeSlotS(i32, slot) { Atomics.store(i32, slotStatusIdx(slot), STATUS_EMPTY); }

function publishAndNotifyShared(ringI32, slot, payloadLen, sharedWakeI32) {
  Atomics.store(ringI32, slotLenIdx(slot), payloadLen);
  Atomics.store(ringI32, slotStatusIdx(slot), STATUS_READY);
  Atomics.add(ringI32, RING_WAKE_IDX, 1);
  Atomics.notify(ringI32, RING_WAKE_IDX);
  Atomics.add(sharedWakeI32, SHARED_WAKE_IDX, 1);
  Atomics.notify(sharedWakeI32, SHARED_WAKE_IDX);
}

// ── Op codes. ───────────────────────────────────────────────────────
// Forward (wasm→host) — simulated napi-arg inspectors (used in NAIVE mode).
const OP_FWD_GET_INT32  = 0xA1;
const OP_FWD_GET_STRLEN = 0xA2;
const OP_FWD_GET_DOUBLE = 0xA3;

// Reverse (host→wasm) — invoke callback funcref. Two variants:
//   NAIVE   payload = [opCode|reqId|funcrefIdx|argIntHandle|argStrHandle|argDblHandle]
//           Wasm side then RPCs back to host to extract each arg's value.
//   BUNDLED payload = [opCode|reqId|funcrefIdx|argInt|argStrLen|argDbl(8B)|strBytes…]
//           Wasm reads everything from the reverse payload — zero forward RPCs.
const OP_REV_INVOKE_CB_NAIVE   = 0xB1;
const OP_REV_INVOKE_CB_BUNDLED = 0xB2;

// ── Test harness control. ───────────────────────────────────────────
const WARMUP = 200;
const ITERS  = 2_000;

if (isMainThread) {
  // ── Allocate SABs. ─────────────────────────────────────────────
  const fwdReqSab = new SharedArrayBuffer(SAB_SIZE);
  const fwdRepSab = new SharedArrayBuffer(SAB_SIZE);
  const revReqSab = new SharedArrayBuffer(SAB_SIZE);
  const revRepSab = new SharedArrayBuffer(SAB_SIZE);
  const sharedWakeSab = new SharedArrayBuffer(64);

  const fwdReqI32 = new Int32Array(fwdReqSab);
  const fwdRepI32 = new Int32Array(fwdRepSab);
  const revReqI32 = new Int32Array(revReqSab);
  const revRepI32 = new Int32Array(revRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);

  const worker = new Worker(new URL(import.meta.url), {
    workerData: { fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab },
  });
  worker.once("error", (e) => { console.error("[host]", e); process.exit(2); });

  // ── Wasm side: handle-id scheme is deterministic — host and wasm agree
  //    that iteration N uses handle ids handleFor(N, 0..2). No setup-RPC.
  //    For BUNDLED mode the args arrive inline; no handle lookup needed.
  // ───────────────────────────────────────────────────────────────

  // ── Forward sync RPC sender (wasm side).
  //    Inside the wait loop we drain reverse requests (which is how
  //    REV_INVOKE_CB gets dispatched while host is awaiting reverse-reply).
  function sendForwardSync(opCode, handleId) {
    const requestId = (Math.random() * 0xfffffff0) >>> 0;
    const slot = tryClaim(fwdReqI32);
    if (slot === -1) throw new Error("forward request ring full");
    const start = slotPayloadStart(slot);
    const dv = new DataView(fwdReqSab, start, 16);
    dv.setUint32(0, opCode, true);
    dv.setUint32(4, requestId, true);
    dv.setUint32(8, handleId, true);
    publishAndNotifyShared(fwdReqI32, slot, 12, sharedWakeI32);

    const deadline = Date.now() + 5_000;
    let lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
    while (Date.now() < deadline) {
      drainReverseRequests();

      for (let s = 0; s < NUM_SLOTS; s++) {
        if (Atomics.load(fwdRepI32, slotStatusIdx(s)) !== STATUS_READY) continue;
        const ps = slotPayloadStart(s);
        const rid = new DataView(fwdRepSab, ps + 4, 4).getUint32(0, true);
        if (rid !== requestId) continue;
        // Reply payload: [op|reqId|status|valueU32 or doubleHi/Lo]
        const status = new DataView(fwdRepSab, ps + 8, 4).getUint32(0, true);
        if (status !== 0) {
          freeSlotS(fwdRepI32, s);
          throw new Error("forward rpc returned error");
        }
        let result;
        if (opCode === OP_FWD_GET_DOUBLE) {
          result = new DataView(fwdRepSab, ps + 12, 8).getFloat64(0, true);
        } else {
          result = new DataView(fwdRepSab, ps + 12, 4).getUint32(0, true);
        }
        freeSlotS(fwdRepI32, s);
        return result;
      }

      const remain = deadline - Date.now();
      if (remain <= 0) break;
      Atomics.wait(sharedWakeI32, SHARED_WAKE_IDX, lastWake, Math.min(remain, 1_000));
      lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
    }
    throw new Error(`fwd sync timeout op=${opCode} reqId=${requestId}`);
  }

  // ── Reverse-request handler (wasm side): dispatches the callback.
  //    NAIVE   — extracts args via 3 forward sync RPCs.
  //    BUNDLED — extracts args inline from the reverse payload.
  function drainReverseRequests() {
    for (let s = 0; s < NUM_SLOTS; s++) {
      const idx = slotStatusIdx(s);
      if (Atomics.compareExchange(revReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
      const start = slotPayloadStart(s);
      const opCode = new DataView(revReqSab, start, 4).getUint32(0, true);
      const reqId  = new DataView(revReqSab, start + 4, 4).getUint32(0, true);

      let result = 0;
      if (opCode === OP_REV_INVOKE_CB_NAIVE) {
        const funcrefIdx = new DataView(revReqSab, start + 8, 4).getUint32(0, true);
        const ha = new DataView(revReqSab, start + 12, 4).getUint32(0, true);
        const hb = new DataView(revReqSab, start + 16, 4).getUint32(0, true);
        const hc = new DataView(revReqSab, start + 20, 4).getUint32(0, true);
        freeSlotS(revReqI32, s);
        // Free the reverse-req slot BEFORE we nest into forward RPCs
        // (mirrors r6 ring-discipline).
        const a = sendForwardSync(OP_FWD_GET_INT32, ha);
        const bLen = sendForwardSync(OP_FWD_GET_STRLEN, hb);
        const c = sendForwardSync(OP_FWD_GET_DOUBLE, hc);
        result = (a + bLen + Math.trunc(c)) >>> 0;
        void funcrefIdx;
      } else if (opCode === OP_REV_INVOKE_CB_BUNDLED) {
        const funcrefIdx = new DataView(revReqSab, start + 8, 4).getUint32(0, true);
        const a = new DataView(revReqSab, start + 12, 4).getInt32(0, true);
        const strLen = new DataView(revReqSab, start + 16, 4).getUint32(0, true);
        const c = new DataView(revReqSab, start + 20, 8).getFloat64(0, true);
        // (We don't actually read the string bytes — strLen is all the
        //  callback needs in this synthetic shape. In production the
        //  bytes would follow at offset start+28; the inspector would
        //  decode them inline.)
        freeSlotS(revReqI32, s);
        result = (a + strLen + Math.trunc(c)) >>> 0;
        void funcrefIdx;
      } else {
        freeSlotS(revReqI32, s);
        result = 0xDEADBEEF >>> 0;
      }

      // Publish reverse-reply.
      const repSlot = tryClaim(revRepI32);
      if (repSlot === -1) throw new Error("reverse reply ring full");
      const rs = slotPayloadStart(repSlot);
      const rdv = new DataView(revRepSab, rs, 16);
      rdv.setUint32(0, opCode, true);
      rdv.setUint32(4, reqId, true);
      rdv.setUint32(8, 0, true);
      rdv.setUint32(12, result, true);
      publishAndNotifyShared(revRepI32, repSlot, 16, sharedWakeI32);
    }
  }

  // ── Wasm "idle" service loop: drain reverse requests until host signals
  //    "done". In real wasm, the worker thread sits in Atomics.wait; here
  //    we poll-loop via setImmediate so the main thread can still process
  //    the worker's "done" message.
  let serving = true;
  worker.on("message", (m) => {
    if (m && m.type === "done") {
      printResults(m);
      serving = false;
      worker.terminate().then(() => process.exit(0));
    }
  });

  function pump() {
    if (!serving) return;
    drainReverseRequests();
    Atomics.wait(sharedWakeI32, SHARED_WAKE_IDX,
                 Atomics.load(sharedWakeI32, SHARED_WAKE_IDX), 1);
    setImmediate(pump);
  }
  setImmediate(pump);

  function printResults(r) {
    const fmt = (arr) => {
      const xs = arr.slice().sort((a, b) => a - b);
      const sum = xs.reduce((a, b) => a + b, 0);
      const mean = sum / xs.length;
      const median = xs[Math.floor(xs.length / 2)];
      const p99 = xs[Math.floor(xs.length * 0.99)];
      const p999 = xs[Math.floor(xs.length * 0.999)];
      return {
        n: xs.length,
        min: xs[0],
        median,
        mean,
        p99,
        p999,
        max: xs[xs.length - 1],
      };
    };

    const baseStats = fmt(r.baseline);
    const naiveStats = fmt(r.naive);
    const bundledStats = fmt(r.bundled);

    const fmtRow = (label, s) =>
      `  ${label.padEnd(18)} n=${s.n}  min=${s.min.toFixed(3)}  median=${s.median.toFixed(3)}  mean=${s.mean.toFixed(3)}  p99=${s.p99.toFixed(3)}  p999=${s.p999.toFixed(3)}  max=${s.max.toFixed(3)}  (µs)`;

    console.log("\n========== E4: realistic-callback latency ==========");
    console.log(fmtRow("in-process",    baseStats));
    console.log(fmtRow("naive (3 fwd)", naiveStats));
    console.log(fmtRow("bundled",       bundledStats));

    const mNaive   = naiveStats.median / baseStats.median;
    const mBundled = bundledStats.median / baseStats.median;
    console.log(`\n  multiplier vs in-process (median):`);
    console.log(`    naive   ≈ ${mNaive.toFixed(0)}×`);
    console.log(`    bundled ≈ ${mBundled.toFixed(0)}×`);

    const project = (n) => ({
      naive_us:   (naiveStats.median   * n).toFixed(1),
      bundled_us: (bundledStats.median * n).toFixed(1),
      base_us:    (baseStats.median    * n).toFixed(3),
    });

    const ee = project(10);
    const sr = project(100);
    const hm = project(50);
    console.log("\n  hot-path projections (median × N fires):");
    console.log(`    EventEmitter 10× : naive=${ee.naive_us}µs   bundled=${ee.bundled_us}µs   inproc=${ee.base_us}µs`);
    console.log(`    Stream _read 100×: naive=${sr.naive_us}µs   bundled=${sr.bundled_us}µs   inproc=${sr.base_us}µs`);
    console.log(`    HTTP middlw  50×: naive=${hm.naive_us}µs   bundled=${hm.bundled_us}µs   inproc=${hm.base_us}µs`);
    console.log("====================================================\n");
  }

} else {
  // ────────────────────────── HOST worker. ──────────────────────────
  const { fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab } = workerData;
  const fwdReqI32 = new Int32Array(fwdReqSab);
  const fwdRepI32 = new Int32Array(fwdRepSab);
  const revReqI32 = new Int32Array(revReqSab);
  const revRepI32 = new Int32Array(revRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);

  // Host-side fake "JS values" for handle lookups (NAIVE mode).
  // For iteration N (0..ITERS-1) the handles host installs are:
  //   ha = N        (int)
  //   hb = string "hello-<N>"  (length = 6+digits)
  //   hc = N * 0.1  (double)
  // The wasm side, when it issues OP_FWD_GET_*, asks host (the actual
  // owner of the JS engine) to inspect them. Here, host's forward handler
  // computes values directly from the handle id.
  //
  // We pack the handle id space: handleId encodes (iter, slot).
  //   iter * 4 + slot+1 → slot in {0=int, 1=str, 2=dbl}
  function handleFor(iter, slot) { return iter * 4 + slot + 1; }
  function decodeHandle(handleId) {
    const iter = (handleId - 1) >>> 2;
    const slot = (handleId - 1) & 3;
    return { iter, slot };
  }
  function valueForHandle(handleId, opCode) {
    const { iter, slot } = decodeHandle(handleId);
    if (slot === 0) return iter; // int
    if (slot === 1) return ("hello-" + iter).length; // strlen (we return length directly)
    if (slot === 2) return iter * 0.1; // double
    return 0;
  }

  // Forward-request drainer (host serves wasm's GET_* RPCs).
  // Poll-based via setImmediate — no Atomics.waitAsync, since multiple
  // concurrent waitAsync promises in the same worker were not resolving
  // reliably.
  let serving = true;
  function forwardPoll() {
    if (!serving) return;
    for (let s = 0; s < NUM_SLOTS; s++) {
      const idx = slotStatusIdx(s);
      if (Atomics.compareExchange(fwdReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
      const start = slotPayloadStart(s);
      const dv = new DataView(fwdReqSab, start, 12);
      const opCode = dv.getUint32(0, true);
      const reqId  = dv.getUint32(4, true);
      const handle = dv.getUint32(8, true);
      freeSlotS(fwdReqI32, s);

      const value = valueForHandle(handle, opCode);

      const repSlot = tryClaim(fwdRepI32);
      if (repSlot === -1) { console.error("[host] fwd reply ring full"); continue; }
      const rs = slotPayloadStart(repSlot);
      const rdv = new DataView(fwdRepSab, rs, 20);
      rdv.setUint32(0, opCode, true);
      rdv.setUint32(4, reqId, true);
      rdv.setUint32(8, 0, true); // status
      if (opCode === OP_FWD_GET_DOUBLE) {
        rdv.setFloat64(12, value, true);
        publishAndNotifyShared(fwdRepI32, repSlot, 20, sharedWakeI32);
      } else {
        rdv.setUint32(12, value >>> 0, true);
        publishAndNotifyShared(fwdRepI32, repSlot, 16, sharedWakeI32);
      }
    }
    setImmediate(forwardPoll);
  }
  setImmediate(forwardPoll);

  // ── Reverse-call sender (host issues REV_INVOKE_CB, awaits reply).
  let nextRevId = 1;
  function allocRevId() {
    const id = nextRevId++;
    if (nextRevId > 0xfffffff0) nextRevId = 1;
    return id;
  }

  async function invokeReverseNaive(iter) {
    const reqId = allocRevId();
    const slot = tryClaim(revReqI32);
    if (slot === -1) throw new Error("reverse request ring full");
    const start = slotPayloadStart(slot);
    const dv = new DataView(revReqSab, start, 24);
    dv.setUint32(0, OP_REV_INVOKE_CB_NAIVE, true);
    dv.setUint32(4, reqId, true);
    dv.setUint32(8, 7777, true); // fake funcref idx
    dv.setUint32(12, handleFor(iter, 0), true);
    dv.setUint32(16, handleFor(iter, 1), true);
    dv.setUint32(20, handleFor(iter, 2), true);
    publishAndNotifyShared(revReqI32, slot, 24, sharedWakeI32);
    return await awaitReverseReply(reqId);
  }

  async function invokeReverseBundled(iter) {
    const reqId = allocRevId();
    const slot = tryClaim(revReqI32);
    if (slot === -1) throw new Error("reverse request ring full");
    const start = slotPayloadStart(slot);
    const strBytes = new TextEncoder().encode("hello-" + iter);
    const headerLen = 28;
    const dv = new DataView(revReqSab, start, headerLen);
    dv.setUint32(0, OP_REV_INVOKE_CB_BUNDLED, true);
    dv.setUint32(4, reqId, true);
    dv.setUint32(8, 7777, true);
    dv.setInt32(12, iter, true);              // a
    dv.setUint32(16, strBytes.length, true);  // strLen
    dv.setFloat64(20, iter * 0.1, true);      // c
    // Copy str bytes after header (callback decoder would read them).
    const dst = new Uint8Array(revReqSab, start + headerLen, strBytes.length);
    dst.set(strBytes);
    publishAndNotifyShared(revReqI32, slot, headerLen + strBytes.length, sharedWakeI32);
    return await awaitReverseReply(reqId);
  }

  // Promise-based: use a microtask-yield poll. Each poll yields via
  // `await new Promise(setImmediate)` so forwardPoll can run between
  // checks. This avoids competing with forwardPoll for waitAsync slots.
  function pollOnce(reqId) {
    for (let s = 0; s < NUM_SLOTS; s++) {
      if (Atomics.load(revRepI32, slotStatusIdx(s)) !== STATUS_READY) continue;
      const ps = slotPayloadStart(s);
      const rdv = new DataView(revRepSab, ps, 16);
      const rid = rdv.getUint32(4, true);
      if (rid !== reqId) continue;
      const result = rdv.getUint32(12, true);
      freeSlotS(revRepI32, s);
      return { found: true, result };
    }
    return { found: false };
  }
  async function awaitReverseReply(reqId) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const r = pollOnce(reqId);
      if (r.found) return r.result;
      await new Promise((res) => setImmediate(res));
    }
    throw new Error("reverse reply timeout");
  }

  // ── In-process baseline: same callback body, no RPC.
  function inProcessCb(a, b, c) {
    return (a + b.length + Math.trunc(c)) >>> 0;
  }

  // ── Run the experiment.
  (async function main() {
    // Warmup naive.
    for (let i = 0; i < WARMUP; i++) await invokeReverseNaive(i);
    // Warmup bundled.
    for (let i = 0; i < WARMUP; i++) await invokeReverseBundled(i);
    // Warmup baseline.
    for (let i = 0; i < WARMUP; i++) inProcessCb(i, "hello-" + i, i * 0.1);

    const baseline = new Array(ITERS);
    const naive    = new Array(ITERS);
    const bundled  = new Array(ITERS);

    // Interleave to give all three the same scheduling environment.
    for (let i = 0; i < ITERS; i++) {
      // baseline
      const t0a = process.hrtime.bigint();
      const _r0 = inProcessCb(i, "hello-" + i, i * 0.1);
      const t1a = process.hrtime.bigint();
      baseline[i] = Number(t1a - t0a) / 1000; // µs
      if (_r0 !== ((i + ("hello-" + i).length + Math.trunc(i * 0.1)) >>> 0)) throw new Error("baseline mismatch");

      // naive
      const t0b = process.hrtime.bigint();
      const r1 = await invokeReverseNaive(i);
      const t1b = process.hrtime.bigint();
      naive[i] = Number(t1b - t0b) / 1000;
      const expect = (i + ("hello-" + i).length + Math.trunc(i * 0.1)) >>> 0;
      if (r1 !== expect) throw new Error(`naive mismatch i=${i} got=${r1} expect=${expect}`);

      // bundled
      const t0c = process.hrtime.bigint();
      const r2 = await invokeReverseBundled(i);
      const t1c = process.hrtime.bigint();
      bundled[i] = Number(t1c - t0c) / 1000;
      if (r2 !== expect) throw new Error(`bundled mismatch i=${i} got=${r2} expect=${expect}`);
    }

    parentPort.postMessage({ type: "done", baseline, naive, bundled });
    serving = false;
  })().catch((e) => { console.error("[host]", e); process.exit(3); });
}
