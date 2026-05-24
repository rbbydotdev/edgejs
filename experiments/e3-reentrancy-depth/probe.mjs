// E3 — re-entrancy depth cliff probe.
//
// Question: at what depth does the nested sync-RPC wait loop blow the JS
// stack on V8?  R6a confirmed depth 16 works.  This probe pushes depth in
// powers of 2 from 32 up to 32768 and reports the cliff and failure mode.
//
// Topology (same as R6a — see r6-nested-sync-rpc/probe.mjs):
//   wasm worker calls sendForwardSync(OP_FWD_RECURSE, n, depth).
//   For depth > 1, host fires reverse REV_RECURSE; wasm's reverse handler
//   recursively calls sendForwardSync(depth-1).  So the JS call stack at
//   the deepest point is roughly 2*depth frames:
//     sendForwardSync(d=N) ── drainReverseRequests ── sendForwardSync(d=N-1)
//     ── drainReverseRequests ── ... ── sendForwardSync(d=1) ── drainReverseRequests
//
// Driver design: orchestrator (top of file) spawns one CHILD per depth so a
// stack overflow in one trial does not poison the next.  Each child runs the
// nested-RPC scenario for that depth in worker threads and prints a single
// machine-readable line.
//
// Each child uses NUM_SLOTS = depth + 16 (rev-rep/fwd-rep slots accumulate
// up to nesting depth — must be roomy enough that ring exhaustion does not
// preempt the stack-cliff signal).

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

// ── ORCHESTRATOR ────────────────────────────────────────────────────────────
async function orchestrate() {
  // Two probe modes:
  //   "rpc":   full SAB round-trip per nested level — measures real-world cliff
  //            (combination of stack + RPC latency × depth).
  //   "stack": pure stack-shape probe — same call-frame topology as the RPC
  //            wait loop, but reverse "drain" returns a synthetic reply
  //            already placed in the ring, so per-frame cost is microseconds.
  //            Isolates the JS-stack cliff.

  const rpcDepths   = [32, 64, 128, 256, 384];
  const stackDepths = process.env.E3_DEEP === "1"
    ? [10000, 16000, 24000, 32000, 48000, 64000, 96000]
    : [256, 1024, 4096, 7000, 8000, 8500, 9000, 9250, 9500, 9750, 10000, 12000];
  // Worker-stack variants: --stack-size is for the MAIN thread; workers are
  // sized via `new Worker(..., { resourceLimits: { stackSizeMb } })`.
  // Probe both axes.
  const stackVariants = process.env.E3_DEEP === "1"
    ? [
        { label: "stack/wsMb=32",  mode: "stack", nodeArgs: [], wsMb: 32 },
        { label: "stack/wsMb=64",  mode: "stack", nodeArgs: [], wsMb: 64 },
      ]
    : [
        { label: "stack/default",  mode: "stack", nodeArgs: [], wsMb: undefined },
        { label: "stack/wsMb=8",   mode: "stack", nodeArgs: [], wsMb: 8 },
        { label: "stack/wsMb=16",  mode: "stack", nodeArgs: [], wsMb: 16 },
        { label: "stack/wsMb=32",  mode: "stack", nodeArgs: [], wsMb: 32 },
      ];
  const variants = process.env.E3_SKIP_RPC === "1"
    ? stackVariants
    : [{ label: "rpc/default", mode: "rpc", nodeArgs: [] }, ...stackVariants];

  const allRows = [];
  for (const v of variants) {
    console.log(`\n=== variant: ${v.label} (node ${v.nodeArgs.join(" ") || "<no flags>"}, workerStackMb=${v.wsMb ?? "default"}) ===`);
    console.log(["depth", "outcome", "p50_ms", "max_ms", "wallMs", "exit", "detail"].map((s) => s.padStart(10)).join(" "));
    const depths = v.mode === "rpc" ? rpcDepths : stackDepths;
    let consecutiveFails = 0;
    for (const depth of depths) {
      const row = await runChildAtDepth(depth, v.mode, v.nodeArgs, v.wsMb);
      allRows.push({ variant: v.label, ...row });
      const cells = [
        String(row.depth).padStart(10),
        row.outcome.padStart(10),
        (row.p50 != null ? row.p50.toFixed(3) : "—").padStart(10),
        (row.max != null ? row.max.toFixed(3) : "—").padStart(10),
        String(row.wallMs).padStart(10),
        String(row.exit).padStart(10),
        row.detail,
      ];
      console.log(cells.join(" "));
      if (row.outcome !== "pass") {
        consecutiveFails++;
        if (consecutiveFails >= 2) {
          console.log(`(stopping ${v.label} — 2 consecutive failures)`);
          break;
        }
      } else {
        consecutiveFails = 0;
      }
    }
  }

  console.log("\n=== summary ===");
  const byVariant = new Map();
  for (const r of allRows) {
    if (!byVariant.has(r.variant)) byVariant.set(r.variant, { highestPass: 0, firstFail: null });
    const v = byVariant.get(r.variant);
    if (r.outcome === "pass") v.highestPass = Math.max(v.highestPass, r.depth);
    else if (v.firstFail == null) v.firstFail = { depth: r.depth, detail: r.detail };
  }
  for (const [variant, v] of byVariant) {
    console.log(`  ${variant}: highest passing depth=${v.highestPass}  first failure at depth=${v.firstFail?.depth ?? "n/a"} (${v.firstFail?.detail ?? ""})`);
  }
}

function runChildAtDepth(depth, mode, nodeArgs, workerStackMb) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, E3_CHILD: "1" };
    if (workerStackMb != null) env.E3_WORKER_STACK_MB = String(workerStackMb);
    const child = spawn("node", [...nodeArgs, SELF, "child", mode, String(depth)], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const KILL_AFTER_MS = mode === "rpc" ? 60_000 : 20_000;
    const killer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, KILL_AFTER_MS);

    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      const wallMs = Date.now() - t0;
      const lastLine = stdout.trim().split("\n").pop() || "";
      let parsed = null;
      try { parsed = JSON.parse(lastLine); } catch {}

      if (parsed && parsed.kind === "result") {
        resolve({
          depth, outcome: parsed.ok ? "pass" : "fail",
          p50: parsed.p50, max: parsed.max,
          wallMs, exit: code ?? signal ?? "-",
          detail: parsed.ok ? "" : (parsed.error || "fail"),
        });
        return;
      }

      // No structured result — child died abnormally.  Classify cause.
      const lower = (stderr + "\n" + stdout).toLowerCase();
      let detail;
      if (signal === "SIGKILL") detail = `timeout(${KILL_AFTER_MS}ms)`;
      else if (lower.includes("maximum call stack")) detail = "stack-overflow";
      else if (lower.includes("rangeerror")) detail = "rangeerror";
      else if (lower.includes("out of memory") || lower.includes("javascript heap")) detail = "oom";
      else if (lower.includes("ring full")) detail = "ring-exhaust";
      else if (lower.includes("timeout")) detail = "rpc-timeout";
      else detail = `exit=${code} sig=${signal}`;

      resolve({ depth, outcome: "fail", p50: null, max: null, wallMs, exit: code ?? signal ?? "-", detail });
    });
  });
}

// ── CHILD (per-depth trial) ─────────────────────────────────────────────────
// Below this point is the R6a-derived nested-RPC harness, parameterised by
// the requested depth.  All numeric constants match R6a unless noted.

const NUM_SLOTS_BASE = 16;
const SLOT_SIZE = 256;
const GH_SIZE   = 16;
const RING_WAKE_IDX = 0;
const STATUS_EMPTY   = 0;
const STATUS_WRITING = 1;
const STATUS_READY   = 2;
const STATUS_READING = 3;
const SHARED_WAKE_IDX = 0;

function slotStatusIdx(slot)    { return (GH_SIZE + slot * SLOT_SIZE) >>> 2; }
function slotLenIdx(slot)       { return (GH_SIZE + slot * SLOT_SIZE + 12) >>> 2; }
function slotPayloadStart(slot) { return GH_SIZE + slot * SLOT_SIZE + 16; }

function tryClaim(i32, numSlots) {
  for (let s = 0; s < numSlots; s++) {
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

const OP_FWD_RECURSE = 0xF2;
const OP_REV_DOUBLE  = 0xB1;
const OP_REV_RECURSE = 0xB2;

function emit(obj) {
  // Last line of stdout is the parseable result line.
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function runChildScenario() {
  const mode = process.argv[3];
  const depth = Number(process.argv[4]);
  if (!Number.isFinite(depth) || depth < 1) {
    emit({ kind: "result", ok: false, error: `bad depth: ${process.argv[4]}` });
    process.exit(1);
  }
  if (mode === "stack") return runStackChild(depth);
  if (mode !== "rpc") {
    emit({ kind: "result", ok: false, error: `bad mode: ${mode}` });
    process.exit(1);
  }

  // Rev-rep/fwd-rep slots accumulate up to depth.  Give headroom.
  const NUM_SLOTS = depth + NUM_SLOTS_BASE;
  const SAB_SIZE  = GH_SIZE + NUM_SLOTS * SLOT_SIZE;

  const fwdReqSab     = new SharedArrayBuffer(SAB_SIZE);
  const fwdRepSab     = new SharedArrayBuffer(SAB_SIZE);
  const revReqSab     = new SharedArrayBuffer(SAB_SIZE);
  const revRepSab     = new SharedArrayBuffer(SAB_SIZE);
  const sharedWakeSab = new SharedArrayBuffer(64);

  // The "wasm side" of the topology — caller of sync RPC.  Runs in a worker
  // so a stack overflow surfaces as a clean worker error, not a process abort.
  // (We still spawn one child per depth; the worker layer is a belt-and-braces
  // safety so we can capture errors structurally.)
  const wasmWorker = new Worker(new URL(import.meta.url), {
    workerData: {
      role: "wasm",
      depth, NUM_SLOTS,
      fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab,
    },
  });
  const hostWorker = new Worker(new URL(import.meta.url), {
    workerData: {
      role: "host",
      depth, NUM_SLOTS,
      fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab,
    },
  });

  const result = await new Promise((resolve) => {
    let resolved = false;
    const done = (r) => { if (!resolved) { resolved = true; resolve(r); } };

    wasmWorker.on("message", (m) => {
      if (m && m.kind === "scenario-done") done(m);
    });
    wasmWorker.on("error", (e) => {
      const msg = (e && e.message) || String(e);
      done({ kind: "scenario-done", ok: false, error: classifyError(msg), raw: msg });
    });
    wasmWorker.on("exit", (code) => {
      if (!resolved) done({ kind: "scenario-done", ok: false, error: `wasm exit ${code}` });
    });
    hostWorker.on("error", (e) => {
      const msg = (e && e.message) || String(e);
      // host failures usually appear as ring-exhaust or rpc-timeout downstream;
      // log but let the wasm worker drive the result.
      console.error(`[host worker error] ${msg}`);
    });
  });

  // Always emit a parseable last line.
  emit({ kind: "result", ok: !!result.ok, p50: result.p50 ?? null, max: result.max ?? null, error: result.error ?? null, raw: result.raw ?? null });

  try { await wasmWorker.terminate(); } catch {}
  try { await hostWorker.terminate(); } catch {}
  process.exit(result.ok ? 0 : 1);
}

function classifyError(msg) {
  const lower = String(msg).toLowerCase();
  if (lower.includes("maximum call stack")) return "stack-overflow";
  if (lower.includes("rangeerror")) return "rangeerror";
  if (lower.includes("out of memory") || lower.includes("javascript heap")) return "oom";
  if (lower.includes("ring full")) return "ring-exhaust";
  if (lower.includes("timeout")) return "rpc-timeout";
  return msg.slice(0, 80);
}

// ── STACK-MODE CHILD ────────────────────────────────────────────────────────
// Isolates the JS stack cliff by reproducing the EXACT call-stack topology of
// the nested-RPC wait loop without paying real RPC round-trip latency.
//
// Frame shape at peak depth D (matches R6a):
//   sendForwardSync(d=D)
//     drainReverseRequests
//       sendForwardSync(d=D-1)
//         drainReverseRequests
//           ... × D
//             sendForwardSync(d=1)
//               drainReverseRequests   (leaf — no recursion)
//
// Trick: instead of waiting for a real host worker to publish a reply, the
// "publish" step writes a pre-baked reply into the fwdRep ring SYNCHRONOUSLY
// before sendForwardSync's wait loop starts.  We also pre-seed a single
// reverse request that drainReverseRequests will see and (for depth>1) recurse
// on.  The frame shape is identical to the real wait loop; only the timing
// changes.  This lets us drive depth up to many thousands in milliseconds.
async function runStackChild(depth) {
  const NUM_SLOTS = depth + NUM_SLOTS_BASE;
  const SAB_SIZE  = GH_SIZE + NUM_SLOTS * SLOT_SIZE;
  const fwdReqSab     = new SharedArrayBuffer(SAB_SIZE);
  const fwdRepSab     = new SharedArrayBuffer(SAB_SIZE);
  const revReqSab     = new SharedArrayBuffer(SAB_SIZE);
  const revRepSab     = new SharedArrayBuffer(SAB_SIZE);
  const sharedWakeSab = new SharedArrayBuffer(64);

  const workerOpts = {
    workerData: {
      role: "stack",
      depth, NUM_SLOTS,
      fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab,
    },
  };
  const wsMb = Number(process.env.E3_WORKER_STACK_MB);
  if (Number.isFinite(wsMb) && wsMb > 0) {
    workerOpts.resourceLimits = { stackSizeMb: wsMb };
  }
  const worker = new Worker(new URL(import.meta.url), workerOpts);

  const result = await new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    worker.on("message", (m) => { if (m && m.kind === "scenario-done") finish(m); });
    worker.on("error", (e) => {
      const msg = (e && e.message) || String(e);
      finish({ kind: "scenario-done", ok: false, error: classifyError(msg), raw: msg });
    });
    worker.on("exit", (code) => {
      if (!done) finish({ kind: "scenario-done", ok: false, error: `worker exit ${code}` });
    });
  });

  emit({ kind: "result", ok: !!result.ok, p50: result.p50 ?? null, max: result.max ?? null, error: result.error ?? null, raw: result.raw ?? null });
  try { await worker.terminate(); } catch {}
  process.exit(result.ok ? 0 : 1);
}

function runStackWorker(wd) {
  const { depth, NUM_SLOTS, fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab } = wd;
  const fwdReqI32     = new Int32Array(fwdReqSab);
  const fwdRepI32     = new Int32Array(fwdRepSab);
  const revReqI32     = new Int32Array(revReqSab);
  const revRepI32     = new Int32Array(revRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);

  let nextReqId = 1;
  function allocReqId() { return nextReqId++; }

  // Pending forward calls we need to fake-reply to.  Map reqId → { n, d }.
  const pending = new Map();

  function sendForwardSync(n, d) {
    const requestId = allocReqId();
    const slot = tryClaim(fwdReqI32, NUM_SLOTS);
    if (slot === -1) throw new Error(`fwdReq ring FULL at d=${d}`);
    // We don't actually need to write the request to SAB for stack-mode —
    // there's no host worker reading it — but write it anyway so the frame
    // shape (DataView creation, atomic store) matches the real wait loop.
    const start = slotPayloadStart(slot);
    const dv = new DataView(fwdReqSab, start, 16);
    dv.setUint32(0, OP_FWD_RECURSE, true);
    dv.setUint32(4, requestId, true);
    dv.setUint32(8, n, true);
    dv.setUint32(12, d, true);
    Atomics.store(fwdReqI32, slotStatusIdx(slot), STATUS_READY);
    pending.set(requestId, { n, d, fwdReqSlot: slot });

    // Synchronously seed the "host" side: place a reverse request that
    // drainReverseRequests will pick up and (for d>1) recurse on.
    seedReverseRequest(requestId, n, d);

    // Now run the wait loop with the same shape as production.
    while (true) {
      drainReverseRequests();

      // Scan forward-reply ring for our reqId.
      for (let s = 0; s < NUM_SLOTS; s++) {
        const idx = slotStatusIdx(s);
        if (Atomics.load(fwdRepI32, idx) !== STATUS_READY) continue;
        const ps = slotPayloadStart(s);
        const rid = new DataView(fwdRepSab, ps + 4, 4).getUint32(0, true);
        if (rid !== requestId) continue;
        const result = new DataView(fwdRepSab, ps + 12, 4).getUint32(0, true);
        freeSlotS(fwdRepI32, s);
        // free the fwdReq slot we claimed (no real host did it for us)
        freeSlotS(fwdReqI32, slot);
        pending.delete(requestId);
        return result;
      }
      // No deadline / Atomics.wait — by construction, drainReverseRequests
      // will always make progress (either recurse and produce inner results,
      // or place the leaf reply).  If it doesn't, that's a bug we want to
      // surface as an infinite-loop, not mask with sleeping.
    }
  }

  function seedReverseRequest(forReqId, n, d) {
    // Caller (depth d) will see this reverse request in its drain loop.
    const slot = tryClaim(revReqI32, NUM_SLOTS);
    if (slot === -1) throw new Error(`revReq ring FULL at d=${d}`);
    const start = slotPayloadStart(slot);
    const dv = new DataView(revReqSab, start, 16);
    if (d <= 1) {
      // leaf — REV_DOUBLE
      dv.setUint32(0, OP_REV_DOUBLE, true);
      dv.setUint32(4, forReqId, true);
      dv.setUint32(8, n, true);
      dv.setUint32(12, 0, true);
    } else {
      dv.setUint32(0, OP_REV_RECURSE, true);
      dv.setUint32(4, forReqId, true);
      dv.setUint32(8, (n * 2) >>> 0, true);
      dv.setUint32(12, d - 1, true);
    }
    Atomics.store(revReqI32, slotStatusIdx(slot), STATUS_READY);
  }

  function placeForwardReply(forReqId, result) {
    const slot = tryClaim(fwdRepI32, NUM_SLOTS);
    if (slot === -1) throw new Error(`fwdRep ring FULL`);
    const start = slotPayloadStart(slot);
    const dv = new DataView(fwdRepSab, start, 16);
    dv.setUint32(0, OP_FWD_RECURSE, true);
    dv.setUint32(4, forReqId, true);
    dv.setUint32(8, 0, true);
    dv.setUint32(12, result, true);
    Atomics.store(fwdRepI32, slotStatusIdx(slot), STATUS_READY);
  }

  function drainReverseRequests() {
    for (let s = 0; s < NUM_SLOTS; s++) {
      const idx = slotStatusIdx(s);
      if (Atomics.compareExchange(revReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
      const start = slotPayloadStart(s);
      const dv = new DataView(revReqSab, start, 16);
      const opCode = dv.getUint32(0, true);
      const forReqId = dv.getUint32(4, true);
      const n = dv.getUint32(8, true);
      const d = dv.getUint32(12, true);
      freeSlotS(revReqI32, s);

      let revResult = 0;
      if (opCode === OP_REV_DOUBLE) {
        revResult = (n * 2) >>> 0;
      } else if (opCode === OP_REV_RECURSE) {
        // recursive call — same shape as production
        revResult = sendForwardSync(n, d) >>> 0;
      } else {
        revResult = 0xDEADBEEF >>> 0;
      }

      // place reverse reply slot (not actually read in stack mode, but
      // keeps frame shape and SAB ops identical)
      const repSlot = tryClaim(revRepI32, NUM_SLOTS);
      if (repSlot === -1) throw new Error(`revRep ring FULL`);
      const rs = slotPayloadStart(repSlot);
      const rdv = new DataView(revRepSab, rs, 16);
      rdv.setUint32(0, opCode, true);
      rdv.setUint32(4, forReqId, true);
      rdv.setUint32(8, 0, true);
      rdv.setUint32(12, revResult, true);
      Atomics.store(revRepI32, slotStatusIdx(repSlot), STATUS_READY);
      // immediately free — no consumer in stack mode
      freeSlotS(revRepI32, repSlot);

      // ALSO place the forward-reply this reverse handler is the "result of":
      // in production, the host async drainer would publish this reply after
      // awaiting callReverse.  Here we synthesise it inline since revResult
      // IS the forward result.
      placeForwardReply(forReqId, revResult);
    }
  }

  // Calibrate: a few iterations.
  const ITERATIONS = depth >= 8000 ? 1 : depth >= 2000 ? 2 : 3;
  function expectedFor(n, d) {
    let r = n >>> 0;
    for (let i = 0; i < d; i++) r = (r * 2) >>> 0;
    return r;
  }

  const timings = [];
  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const n = (i + 1) >>> 0;
      const expected = expectedFor(n, depth);
      const t0 = process.hrtime.bigint();
      const got = sendForwardSync(n, depth);
      const t1 = process.hrtime.bigint();
      timings.push(Number(t1 - t0) / 1e6);
      if (got !== expected) {
        parentPort.postMessage({ kind: "scenario-done", ok: false, error: `mismatch n=${n} d=${depth} expected=${expected} got=${got}` });
        return;
      }
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const max = timings[timings.length - 1];
    parentPort.postMessage({ kind: "scenario-done", ok: true, p50, max });
  } catch (e) {
    const raw = (e && e.stack) ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e);
    parentPort.postMessage({ kind: "scenario-done", ok: false, error: classifyError(e?.message ?? String(e)), raw });
  }
}

// ── WASM-side worker ────────────────────────────────────────────────────────
function runWasmWorker(wd) {
  const { depth, NUM_SLOTS, fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab } = wd;
  const fwdReqI32     = new Int32Array(fwdReqSab);
  const fwdRepI32     = new Int32Array(fwdRepSab);
  const revReqI32     = new Int32Array(revReqSab);
  const revRepI32     = new Int32Array(revRepSab);
  const sharedWakeI32 = new Int32Array(sharedWakeSab);

  let nextReqId = 1;
  function allocReqId() {
    const id = nextReqId++;
    if (nextReqId > 0xfffffff0) nextReqId = 1;
    return id;
  }

  let currentDepth = 0;
  let maxDepthSeen = 0;

  function sendForwardSync(opCode, n, d) {
    currentDepth++;
    if (currentDepth > maxDepthSeen) maxDepthSeen = currentDepth;
    try {
      const requestId = allocReqId();
      const slot = tryClaim(fwdReqI32, NUM_SLOTS);
      if (slot === -1) throw new Error(`forward request ring FULL at depth ${currentDepth}`);
      const start = slotPayloadStart(slot);
      const dv = new DataView(fwdReqSab, start, 16);
      dv.setUint32(0, opCode, true);
      dv.setUint32(4, requestId, true);
      dv.setUint32(8, n, true);
      dv.setUint32(12, d, true);
      publishAndNotifyShared(fwdReqI32, slot, 16, sharedWakeI32);

      const deadline = Date.now() + 25_000;
      let lastWake = Atomics.load(sharedWakeI32, SHARED_WAKE_IDX);
      while (Date.now() < deadline) {
        drainReverseRequests();
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

  function drainReverseRequests() {
    for (let s = 0; s < NUM_SLOTS; s++) {
      const idx = slotStatusIdx(s);
      if (Atomics.compareExchange(revReqI32, idx, STATUS_READY, STATUS_READING) !== STATUS_READY) continue;
      const start = slotPayloadStart(s);
      const dv = new DataView(revReqSab, start, 16);
      const opCode = dv.getUint32(0, true);
      const reqId  = dv.getUint32(4, true);
      const n      = dv.getUint32(8, true);
      const d      = dv.getUint32(12, true);
      freeSlotS(revReqI32, s);

      let result = 0;
      if (opCode === OP_REV_DOUBLE) {
        result = (n * 2) >>> 0;
      } else if (opCode === OP_REV_RECURSE) {
        result = sendForwardSync(OP_FWD_RECURSE, n, d) >>> 0;
      } else {
        result = 0xDEADBEEF >>> 0;
      }

      const repSlot = tryClaim(revRepI32, NUM_SLOTS);
      if (repSlot === -1) throw new Error(`reverse REPLY ring full reqId=${reqId}`);
      const rs = slotPayloadStart(repSlot);
      const rdv = new DataView(revRepSab, rs, 16);
      rdv.setUint32(0, opCode, true);
      rdv.setUint32(4, reqId, true);
      rdv.setUint32(8, 0, true);
      rdv.setUint32(12, result, true);
      publishAndNotifyShared(revRepI32, repSlot, 16, sharedWakeI32);
    }
  }

  // Run scenario: small number of iterations at the requested depth.
  // We only need a handful per depth — the cliff signal is binary.
  const ITERATIONS = depth >= 4096 ? 2 : depth >= 512 ? 5 : 10;

  function expectedFor(n, d) {
    let r = n >>> 0;
    for (let i = 0; i < d; i++) r = (r * 2) >>> 0;
    return r;
  }

  const timings = [];
  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const n = (i + 1) >>> 0;
      const expected = expectedFor(n, depth);
      const t0 = process.hrtime.bigint();
      const got = sendForwardSync(OP_FWD_RECURSE, n, depth);
      const t1 = process.hrtime.bigint();
      timings.push(Number(t1 - t0) / 1e6);
      if (got !== expected) {
        parentPort.postMessage({ kind: "scenario-done", ok: false, error: `mismatch n=${n} d=${depth} expected=${expected} got=${got}`, maxDepthSeen });
        return;
      }
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const max = timings[timings.length - 1];
    parentPort.postMessage({ kind: "scenario-done", ok: true, p50, max, maxDepthSeen });
  } catch (e) {
    const raw = (e && e.stack) ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e);
    parentPort.postMessage({ kind: "scenario-done", ok: false, error: classifyError(e?.message ?? String(e)), raw, maxDepthSeen });
  }
}

// ── HOST-side worker ────────────────────────────────────────────────────────
function runHostWorker(wd) {
  const { depth, NUM_SLOTS, fwdReqSab, fwdRepSab, revReqSab, revRepSab, sharedWakeSab } = wd;
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

  async function callReverse(opCode, n, d) {
    const reqId = allocRevId();
    let slot = -1;
    for (let attempt = 0; slot === -1 && attempt < 5000; attempt++) {
      slot = tryClaim(revReqI32, NUM_SLOTS);
      if (slot === -1) await new Promise((r) => setImmediate(r));
    }
    if (slot === -1) throw new Error("[host] reverse request ring full");

    const start = slotPayloadStart(slot);
    const dv = new DataView(revReqSab, start, 16);
    dv.setUint32(0, opCode, true);
    dv.setUint32(4, reqId, true);
    dv.setUint32(8, n, true);
    dv.setUint32(12, d, true);
    publishAndNotifyShared(revReqI32, slot, 16, sharedWakeI32);

    const deadline = Date.now() + 25_000;
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
    throw new Error(`[host] reverse reply timeout reqId=${reqId}`);
  }

  async function handleForward(opCode, reqId, n, d) {
    let result;
    if (opCode === OP_FWD_RECURSE) {
      if (d <= 1) {
        result = await callReverse(OP_REV_DOUBLE, n, 0);
      } else {
        const doubled = (n * 2) >>> 0;
        result = await callReverse(OP_REV_RECURSE, doubled, d - 1);
      }
    } else {
      result = 0xDEADBEEF >>> 0;
    }
    let repSlot = -1;
    for (let attempt = 0; repSlot === -1 && attempt < 5000; attempt++) {
      repSlot = tryClaim(fwdRepI32, NUM_SLOTS);
      if (repSlot === -1) await new Promise((r) => setImmediate(r));
    }
    if (repSlot === -1) return;
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
        const d      = dv.getUint32(12, true);
        freeSlotS(fwdReqI32, s);
        handleForward(opCode, reqId, n, d).catch((e) => {
          console.error(`[host] handleForward error: ${e.message}`);
        });
      }
      if (!pickedAny) {
        const r = Atomics.waitAsync(fwdReqI32, RING_WAKE_IDX, lastWake, 250);
        if (r.async) await r.value;
        lastWake = Atomics.load(fwdReqI32, RING_WAKE_IDX);
      } else {
        await new Promise((r) => setImmediate(r));
        lastWake = Atomics.load(fwdReqI32, RING_WAKE_IDX);
      }
    }
  })();
}

// ── Entry dispatch ──────────────────────────────────────────────────────────
if (isMainThread) {
  if (process.argv[2] === "child") {
    runChildScenario().catch((e) => {
      emit({ kind: "result", ok: false, error: classifyError(e?.message ?? String(e)) });
      process.exit(1);
    });
  } else {
    orchestrate().catch((e) => {
      console.error("orchestrator error:", e);
      process.exit(1);
    });
  }
} else {
  if (workerData?.role === "wasm") runWasmWorker(workerData);
  else if (workerData?.role === "host") runHostWorker(workerData);
  else if (workerData?.role === "stack") runStackWorker(workerData);
}
