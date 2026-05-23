// R6a nested sync RPC probe.
//
// Question: can SyncRpcClient.callSync be RE-ENTERED from inside a
// reverse-channel callback handler, such that the inner call gets its
// own slot, blocks on its own wait, completes, returns, and the outer
// wait then resumes correctly?
//
// R1 validated depth-1 (one forward, one reverse, no inner forward).
// R6a validates depth-2+ (reverse handler issues another forward sync).
//
// Layout — exactly R1's SAB layout: 4 rings + 1 shared wake counter.
// We extend the wait loop to RECURSIVELY drain reverse requests and
// handle reverse ops that themselves call sendForwardSync.
//
// Topology:
//   main = "wasm worker" — sync RPC caller; reverse handler also calls
//                          sendForwardSync (recursion).
//   worker = "host worker" — async drainer; when it sees a forward
//                            request that wants nesting depth N, it
//                            issues a reverse asking wasm to either
//                            do leaf work (depth==1) or recurse
//                            (depth>1) by issuing a forward back to
//                            host with depth-1.
//
// Forward op  OP_FWD_RECURSE  — args [n, depth]. Host returns f(n,depth)
//   where f(n, 1) = n*2 (leaf, computed by wasm via reverse) and
//         f(n, d) = f(n*2, d-1).
//   For d=1 the host fires one reverse REV_DOUBLE.
//   For d>1 the host fires one reverse REV_RECURSE asking wasm to
//   recurse on the OUTER ring: wasm-side reverse handler issues a
//   NEW sendForwardSync(OP_FWD_RECURSE, n*2, depth-1).
//
// Net check: final result of OP_FWD_RECURSE(n, depth) == n * 2^depth.

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";

// ── SAB ring layout (matches R1).
const NUM_SLOTS = Number(process.env.NUM_SLOTS || 8);  // Override for ring-exhaustion sweeps.
const SLOT_SIZE = 256;
const GH_SIZE   = 16;
const SAB_SIZE  = GH_SIZE + NUM_SLOTS * SLOT_SIZE;

const RING_WAKE_IDX = 0;

const STATUS_EMPTY   = 0;
const STATUS_WRITING = 1;
const STATUS_READY   = 2;
const STATUS_READING = 3;

const SHARED_WAKE_IDX = 0;

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

function freeSlotS(i32, slot) {
  Atomics.store(i32, slotStatusIdx(slot), STATUS_EMPTY);
}

function publishAndNotifyShared(ringI32, slot, payloadLen, sharedWakeI32) {
  Atomics.store(ringI32, slotLenIdx(slot), payloadLen);
  Atomics.store(ringI32, slotStatusIdx(slot), STATUS_READY);
  Atomics.add(ringI32, RING_WAKE_IDX, 1);
  Atomics.notify(ringI32, RING_WAKE_IDX);
  Atomics.add(sharedWakeI32, SHARED_WAKE_IDX, 1);
  Atomics.notify(sharedWakeI32, SHARED_WAKE_IDX);
}

// ── Op codes.
// Forward (wasm -> host):
//   OP_FWD_RECURSE   args [n:u32, depth:u32]   result n * 2^depth
// Reverse (host -> wasm):
//   OP_REV_DOUBLE    args [n:u32]              result n*2  (leaf, pure compute)
//   OP_REV_RECURSE   args [n:u32, depth:u32]   result = the recursive forward call result.
const OP_FWD_RECURSE = 0xF2;
const OP_REV_DOUBLE  = 0xB1;
const OP_REV_RECURSE = 0xB2;

if (isMainThread) {
  // ── Allocate SABs.
  const fwdReqSab     = new SharedArrayBuffer(SAB_SIZE);
  const fwdRepSab     = new SharedArrayBuffer(SAB_SIZE);
  const revReqSab     = new SharedArrayBuffer(SAB_SIZE);
  const revRepSab     = new SharedArrayBuffer(SAB_SIZE);
  const sharedWakeSab = new SharedArrayBuffer(64);

  const fwdReqI32     = new Int32Array(fwdReqSab);
  const fwdRepI32     = new Int32Array(fwdRepSab);
  const revReqI32     = new Int32Array(revReqSab);
  const revRepI32     = new Int32Array(revRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);

  const worker = new Worker(new URL(import.meta.url), {
    workerData: { fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab, NUM_SLOTS, SLOT_SIZE },
  });
  worker.once("error", (e) => { console.error("[host]", e); process.exit(2); });
  worker.once("exit", (code) => {
    if (code !== 0) {
      console.error(`[host] exited with code ${code}`);
      process.exit(code || 1);
    }
  });

  // ── Re-entrant sync RPC client.  RequestId is unique per call (counter);
  // wait loop matches reply by requestId, NOT by slot.  drainReverseRequests
  // is the recursive hot-spot — it may re-enter sendForwardSync.
  let nextReqId = 1;
  function allocReqId() {
    const id = nextReqId++;
    if (nextReqId > 0xfffffff0) nextReqId = 1;
    return id;
  }

  // Re-entrancy depth tracking (for stats + ring-exhaustion diagnostics).
  let currentDepth = 0;
  let maxDepthSeen = 0;
  let outOfSlotsCount = 0;

  function sendForwardSync(opCode, n, depth) {
    currentDepth++;
    if (currentDepth > maxDepthSeen) maxDepthSeen = currentDepth;
    try {
      const requestId = allocReqId();
      const slot = tryClaim(fwdReqI32);
      if (slot === -1) {
        outOfSlotsCount++;
        throw new Error(`forward request ring FULL at re-entry depth ${currentDepth} (ring=${NUM_SLOTS} slots)`);
      }
      const start = slotPayloadStart(slot);
      const dv = new DataView(fwdReqSab, start, 16);
      dv.setUint32(0, opCode, true);
      dv.setUint32(4, requestId, true);
      dv.setUint32(8, n, true);
      dv.setUint32(12, depth, true);
      publishAndNotifyShared(fwdReqI32, slot, 16, sharedWakeI32);

      const deadline = Date.now() + 10_000;
      let lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
      while (Date.now() < deadline) {
        // 1. Drain reverse requests FIRST (may RECURSE into sendForwardSync).
        drainReverseRequests();

        // 2. Scan forward-reply ring for OUR requestId.
        for (let s = 0; s < NUM_SLOTS; s++) {
          const idx = slotStatusIdx(s);
          if (Atomics.load(fwdRepI32, idx) !== STATUS_READY) continue;
          const ps = slotPayloadStart(s);
          const rid = new DataView(fwdRepSab, ps + 4, 4).getUint32(0, true);
          if (rid !== requestId) continue; // not ours — leave for other (outer) wait.
          const result = new DataView(fwdRepSab, ps + 12, 4).getUint32(0, true);
          freeSlotS(fwdRepI32, s);
          return result;
        }

        const remain = deadline - Date.now();
        if (remain <= 0) break;
        Atomics.wait(sharedWakeI32, SHARED_WAKE_IDX, lastWake, Math.min(remain, 1_000));
        lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
      }
      throw new Error(`forward sync call timeout reqId=${requestId} depth=${currentDepth}`);
    } finally {
      currentDepth--;
    }
  }

  // Reverse handlers — runs SYNCHRONOUSLY on the wasm thread inside the
  // wait loop.  Can recursively invoke sendForwardSync.
  function drainReverseRequests() {
    for (let s = 0; s < NUM_SLOTS; s++) {
      const idx = slotStatusIdx(s);
      if (Atomics.compareExchange(revReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
      const start = slotPayloadStart(s);
      const dv = new DataView(revReqSab, start, 16);
      const opCode = dv.getUint32(0, true);
      const reqId  = dv.getUint32(4, true);
      const n      = dv.getUint32(8, true);
      const depth  = dv.getUint32(12, true);
      freeSlotS(revReqI32, s);

      let result = 0;
      if (opCode === OP_REV_DOUBLE) {
        // Pure leaf compute.
        result = (n * 2) >>> 0;
      } else if (opCode === OP_REV_RECURSE) {
        // *** The R6 case ***  Issue another forward sync from inside the
        // reverse handler.  This recursion is what we're testing.
        result = sendForwardSync(OP_FWD_RECURSE, n, depth) >>> 0;
      } else {
        result = 0xDEADBEEF >>> 0;
      }

      const repSlot = tryClaim(revRepI32);
      if (repSlot === -1) {
        // Should never happen with NUM_SLOTS reply slots vs depth-N nesting
        // BUT IT CAN — investigate. Print and continue.
        console.error(`[wasm] reverse REPLY ring full for reqId=${reqId}`);
        continue;
      }
      const rs = slotPayloadStart(repSlot);
      const rdv = new DataView(revRepSab, rs, 16);
      rdv.setUint32(0, opCode, true);
      rdv.setUint32(4, reqId, true);
      rdv.setUint32(8, 0, true);
      rdv.setUint32(12, result, true);
      publishAndNotifyShared(revRepI32, repSlot, 16, sharedWakeI32);
    }
  }

  // ── Run scenarios.

  function expectedFor(n, depth) {
    let r = n >>> 0;
    for (let i = 0; i < depth; i++) r = (r * 2) >>> 0;
    return r;
  }

  function runScenario(label, depth, iterations) {
    const timings = [];
    let ok = true;
    const beforeMaxDepth = maxDepthSeen;
    for (let i = 0; i < iterations; i++) {
      const n = (i + 1) >>> 0;
      const expected = expectedFor(n, depth);
      const t0 = process.hrtime.bigint();
      let result;
      try {
        result = sendForwardSync(OP_FWD_RECURSE, n, depth);
      } catch (e) {
        console.error(`[${label}] iter ${i} threw: ${e.message}`);
        ok = false;
        break;
      }
      const t1 = process.hrtime.bigint();
      timings.push(Number(t1 - t0) / 1e6);
      if (result !== expected) {
        console.error(`[${label}] iter ${i}: n=${n} depth=${depth} expected ${expected} got ${result}`);
        ok = false;
        break;
      }
    }
    timings.sort((a, b) => a - b);
    const pct = (p) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))];
    const summary = timings.length === 0 ? "no-data" :
      `min=${timings[0].toFixed(3)} p50=${pct(0.5).toFixed(3)} p99=${pct(0.99).toFixed(3)} max=${timings[timings.length - 1].toFixed(3)} ms`;
    const observedMax = maxDepthSeen; // total cumulative; reverse-handler depth = depth*2 - 1 frames
    console.log(`[${label}] depth=${depth} iters=${iterations} ${ok ? "PASS" : "FAIL"}  ${summary}  observedReentryFrames(cumulative)=${observedMax}`);
    return { ok, timings, label, depth };
  }

  // Scenario 1: depth 1 — R1 baseline (sanity).  Reverse handler is leaf (OP_REV_DOUBLE).
  // Slight subtlety: for depth=1 the host issues REV_DOUBLE (leaf). For depth>=2 host
  // issues REV_RECURSE with depth-1. See host-side serve() below.
  console.log("=== R6a nested sync RPC probe ===");
  console.log(`ring=${NUM_SLOTS} slots, slot=${SLOT_SIZE} bytes`);

  const s1 = runScenario("scn1 depth-1 baseline", 1, 500);
  const s2 = runScenario("scn2 depth-2",          2, 200);
  const s3 = runScenario("scn3 depth-3",          3, 100);
  const s4 = runScenario("scn4 depth-4",          4, 50);
  const s5 = runScenario("scn5 depth-6",          6, 25);

  // Scenario: ring-exhaustion probe.
  //
  // Slot holding pattern observed:
  //   - fwd-req slot: held BRIEFLY (wasm publishes → host claims & frees on pickup).
  //     So even very deep nesting does not saturate fwd-req.
  //   - rev-req slot: published by host, held until wasm reverse handler claims it.
  //     For depth-N nested, each nested level publishes ONE reverse request that
  //     can sit in the ring while wasm processes prior ones in the loop. With
  //     deep nesting, reverse-req slots accumulate up to nesting depth.
  //   - rev-rep / fwd-rep slots: each pending nested call holds ONE reply slot
  //     until the deepest nest unwinds — so peak holders is ~depth.
  //
  // Therefore the limiting ring is fwd-rep / rev-rep at depth ~= NUM_SLOTS.
  // Try depths up to and beyond NUM_SLOTS to find the cliff.
  console.log("--- ring exhaustion probe ---");
  const exhDepths = [NUM_SLOTS - 1, NUM_SLOTS, NUM_SLOTS + 1, NUM_SLOTS + 4, NUM_SLOTS * 2];
  for (const d of exhDepths) {
    let result, error;
    try {
      const t0 = process.hrtime.bigint();
      result = sendForwardSync(OP_FWD_RECURSE, 1, d);
      const t1 = process.hrtime.bigint();
      const expected = expectedFor(1, d);
      const ms = (Number(t1 - t0) / 1e6).toFixed(3);
      console.log(`[exh] depth=${d}  result=${result}  expected=${expected}  ${result === expected ? "OK" : "MISMATCH"}  ${ms}ms`);
    } catch (e) {
      error = e.message;
      console.log(`[exh] depth=${d}  THROW  ${error}`);
    }
  }

  console.log(`maxDepthSeen=${maxDepthSeen} outOfSlotsCount=${outOfSlotsCount}`);

  const allOk = s1.ok && s2.ok && s3.ok && s4.ok && s5.ok;
  const summary = allOk
    ? "RESULT: PASS — re-entrant nested sync RPC works up to depth 6."
    : "RESULT: FAIL — see scenario errors above.";
  console.log(summary);

  worker.postMessage("stop");
  setTimeout(() => process.exit(allOk ? 0 : 1), 200);
} else {
  // ── HOST worker.  Async drainer for forward requests.
  //
  // For OP_FWD_RECURSE(n, depth):
  //   if depth == 1:  issue REV_DOUBLE(n) -> leaf reverse on wasm; reply n*2.
  //   if depth >  1:  issue REV_RECURSE(n*2, depth-1).  Wasm reverse handler
  //                   will SYNCHRONOUSLY call back to us via sendForwardSync,
  //                   we serve that nested forward in this same drainer,
  //                   eventually producing result; reply that.
  //
  // The host async drainer is naturally re-entrant via async iteration: a
  // pending forward request from the nested call will be picked up by the
  // serve() loop on the next iteration because we publish its reply ASAP.
  // We use a CONCURRENT serve pattern: each forward request gets its own
  // async handler so nested forwards from wasm don't deadlock behind
  // a serial loop.

  const { fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab } = workerData;
  const fwdReqI32     = new Int32Array(fwdReqSab);
  const fwdRepI32     = new Int32Array(fwdRepSab);
  const revReqI32     = new Int32Array(revReqSab);
  const revRepI32     = new Int32Array(revRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);

  let nextRevId = 1;
  function allocRevId() {
    const id = nextRevId++;
    if (nextRevId > 0xfffffff0) nextRevId = 1;
    return id;
  }

  // Send a reverse request, await reverse reply asynchronously.
  // Matches by reqId (so concurrent reverses interleave safely).
  async function callReverse(opCode, n, depth) {
    const reqId = allocRevId();
    let slot = -1;
    // Spin until a slot is available (host is async — that's fine).
    for (let attempt = 0; slot === -1 && attempt < 1000; attempt++) {
      slot = tryClaim(revReqI32);
      if (slot === -1) await new Promise((r) => setImmediate(r));
    }
    if (slot === -1) throw new Error("[host] reverse request ring full");

    const start = slotPayloadStart(slot);
    const dv = new DataView(revReqSab, start, 16);
    dv.setUint32(0, opCode, true);
    dv.setUint32(4, reqId, true);
    dv.setUint32(8, n, true);
    dv.setUint32(12, depth, true);
    publishAndNotifyShared(revReqI32, slot, 16, sharedWakeI32);

    const deadline = Date.now() + 10_000;
    let lastWake = Atomics.load(revRepI32, RING_WAKE_IDX);
    while (Date.now() < deadline) {
      for (let s = 0; s < NUM_SLOTS; s++) {
        if (Atomics.load(revRepI32, slotStatusIdx(s)) !== STATUS_READY) continue;
        const ps = slotPayloadStart(s);
        const rdv = new DataView(revRepSab, ps, 16);
        const rid = rdv.getUint32(4, true);
        if (rid !== reqId) continue; // not ours — leave for the other awaiter.
        const result = rdv.getUint32(12, true);
        freeSlotS(revRepI32, s);
        return result;
      }
      const r = Atomics.waitAsync(revRepI32, RING_WAKE_IDX, lastWake, 1_000);
      if (r.async) await r.value;
      lastWake = Atomics.load(revRepI32, RING_WAKE_IDX);
    }
    throw new Error(`[host] reverse reply timeout reqId=${reqId} op=${opCode.toString(16)}`);
  }

  async function handleForward(opCode, reqId, n, depth) {
    let result;
    if (opCode === OP_FWD_RECURSE) {
      if (depth <= 1) {
        result = await callReverse(OP_REV_DOUBLE, n, 0);
      } else {
        // Ask wasm to recurse: it will issue another OP_FWD_RECURSE(n*2, depth-1)
        // from inside its reverse handler.
        const doubled = (n * 2) >>> 0;
        result = await callReverse(OP_REV_RECURSE, doubled, depth - 1);
      }
    } else {
      result = 0xDEADBEEF >>> 0;
    }

    // Publish forward reply.
    let repSlot = -1;
    for (let attempt = 0; repSlot === -1 && attempt < 1000; attempt++) {
      repSlot = tryClaim(fwdRepI32);
      if (repSlot === -1) await new Promise((r) => setImmediate(r));
    }
    if (repSlot === -1) {
      console.error(`[host] forward reply ring full for reqId=${reqId}`);
      return;
    }
    const rs = slotPayloadStart(repSlot);
    const rdv = new DataView(fwdRepSab, rs, 16);
    rdv.setUint32(0, opCode, true);
    rdv.setUint32(4, reqId, true);
    rdv.setUint32(8, 0, true);
    rdv.setUint32(12, result, true);
    publishAndNotifyShared(fwdRepI32, repSlot, 16, sharedWakeI32);
  }

  let serving = true;
  parentPort.on("message", (m) => { if (m === "stop") serving = false; });

  (async function serve() {
    let lastWake = Atomics.load(fwdReqI32, RING_WAKE_IDX);
    while (serving) {
      let pickedAny = false;
      for (let s = 0; s < NUM_SLOTS; s++) {
        const idx = slotStatusIdx(s);
        if (Atomics.compareExchange(fwdReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
        pickedAny = true;
        const start = slotPayloadStart(s);
        const dv = new DataView(fwdReqSab, start, 16);
        const opCode = dv.getUint32(0, true);
        const reqId  = dv.getUint32(4, true);
        const n      = dv.getUint32(8, true);
        const depth  = dv.getUint32(12, true);
        freeSlotS(fwdReqI32, s);

        // Fire-and-forget concurrent handler so nested forwards from wasm
        // (which arrive while we're awaiting a reverse reply) get processed.
        handleForward(opCode, reqId, n, depth).catch((e) => {
          console.error(`[host] handleForward error: ${e.message}`);
        });
      }
      if (!pickedAny) {
        const r = Atomics.waitAsync(fwdReqI32, RING_WAKE_IDX, lastWake, 250);
        if (r.async) await r.value;
        lastWake = Atomics.load(fwdReqI32, RING_WAKE_IDX);
      } else {
        // Yield so concurrent handleForward() promises can progress.
        await new Promise((r) => setImmediate(r));
        lastWake = Atomics.load(fwdReqI32, RING_WAKE_IDX);
      }
    }
  })();
}
