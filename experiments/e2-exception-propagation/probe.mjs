// E2 — exception propagation through reverse RPC.
//
// The host worker invokes wasm callbacks via reverse RPC
// (OP_INVOKE_WASM_CALLBACK).  If the callback throws, the reply must
// carry the exception so the host's JS wrapper can re-throw a real
// Error.  This probe finds the right wire format.
//
// Single-direction SAB ring is sufficient — marshalling is direction-
// agnostic.
//
// Options under test:
//   A — message-only      payload = utf8(message)
//   B — JSON              payload = utf8(JSON.stringify({name,message,stack}))
//   C — structured-clone  REQUIRES postMessage; cannot run inside
//                         Atomics.wait → incompatible with sync RPC.
//                         Documented & skipped.
//   D — typed (TLV)       payload = [name][message][stack] each
//                         prefixed by u32 LE byte length.
//
// We also probe what napi_throw_error / pending-exception path looks
// like from the JS perspective and recommend a flow.

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";

// ──────────────────────────────────────────────────────────────────
// Encoders / decoders
// ──────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

// Option A — message only
function encodeA(err) {
  return enc.encode(err.message ?? "");
}
function decodeA(bytes) {
  const e = new Error(dec.decode(bytes));
  return e;
}

// Option B — JSON
function encodeB(err) {
  return enc.encode(JSON.stringify({
    name: err.name,
    message: err.message,
    stack: err.stack,
  }));
}
function decodeB(bytes) {
  const o = JSON.parse(dec.decode(bytes));
  const e = new Error(o.message);
  e.name = o.name;
  e.stack = o.stack;
  return e;
}

// Option D — typed (TLV: 3 length-prefixed UTF-8 strings)
function encodeD(err) {
  const nameB = enc.encode(err.name ?? "Error");
  const msgB = enc.encode(err.message ?? "");
  const stackB = enc.encode(err.stack ?? "");
  const total = 12 + nameB.length + msgB.length + stackB.length;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let o = 0;
  dv.setUint32(o, nameB.length, true); o += 4;
  u8.set(nameB, o); o += nameB.length;
  dv.setUint32(o, msgB.length, true); o += 4;
  u8.set(msgB, o); o += msgB.length;
  dv.setUint32(o, stackB.length, true); o += 4;
  u8.set(stackB, o); o += stackB.length;
  return u8;
}
function decodeD(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const nLen = dv.getUint32(o, true); o += 4;
  const name = dec.decode(bytes.subarray(o, o + nLen)); o += nLen;
  const mLen = dv.getUint32(o, true); o += 4;
  const message = dec.decode(bytes.subarray(o, o + mLen)); o += mLen;
  const sLen = dv.getUint32(o, true); o += 4;
  const stack = dec.decode(bytes.subarray(o, o + sLen)); o += sLen;
  const e = new Error(message);
  e.name = name;
  e.stack = stack;
  return e;
}

// ──────────────────────────────────────────────────────────────────
// Fixtures: errors with different stack sizes
// ──────────────────────────────────────────────────────────────────

function makeError(stackTargetBytes) {
  // Build a deep call chain so the engine actually produces a real
  // stack, then pad if needed to hit the target size.
  function frame(depth) {
    if (depth === 0) {
      const e = new Error("synthetic failure inside wasm callback");
      return e;
    }
    return frame(depth - 1);
  }
  const depth = Math.max(1, Math.floor(stackTargetBytes / 60));
  const e = frame(depth);
  while ((e.stack ?? "").length < stackTargetBytes) {
    e.stack = (e.stack ?? "") + "\n    at synthetic_pad_frame (probe.mjs:0:0)";
  }
  return e;
}

class CustomError extends Error {
  constructor(msg, code) {
    super(msg);
    this.name = "CustomError";
    this.code = code;
  }
}

// ──────────────────────────────────────────────────────────────────
// SAB ring transport — sender writes payload, receiver reads via
// Atomics.wait.  Single direction is enough for marshalling probe.
// ──────────────────────────────────────────────────────────────────

const RING_BYTES = 1 << 20; // 1 MiB payload area
const CTRL_REQ_SEQ = 0;     // i32 index 0 — bumped by sender
const CTRL_ACK_SEQ = 1;     // i32 index 1 — bumped by receiver
const CTRL_LEN = 2;         // i32 index 2 — payload byte length
const CTRL_OPT = 3;         // i32 index 3 — option tag (0=A,1=B,3=D)

if (isMainThread) {
  await main();
} else {
  await worker();
}

async function main() {
  const ctrlSab = new SharedArrayBuffer(32);
  const dataSab = new SharedArrayBuffer(RING_BYTES);
  const ctrl = new Int32Array(ctrlSab);
  const data = new Uint8Array(dataSab);

  const w = new Worker(new URL(import.meta.url), {
    workerData: { ctrlSab, dataSab },
  });

  // wait for worker to signal ready
  await new Promise((r) => w.once("message", (m) => m === "ready" && r()));

  const sizes = [
    { label: "~200B",  bytes: 200 },
    { label: "~1KB",   bytes: 1024 },
    { label: "~5KB",   bytes: 5 * 1024 },
  ];

  const options = [
    { tag: 0, name: "A message-only", enc: encodeA, dec: decodeA },
    { tag: 1, name: "B JSON         ", enc: encodeB, dec: decodeB },
    { tag: 3, name: "D typed TLV    ", enc: encodeD, dec: decodeD },
  ];

  console.log("\n=== 1. throughput (encode + send + decode, 1000 iters) ===");
  console.log("option           | size   | enc/dec μs | wire bytes");
  console.log("-----------------+--------+------------+-----------");

  for (const sz of sizes) {
    const err = makeError(sz.bytes);
    for (const opt of options) {
      const ITERS = 1000;
      const t0 = performance.now();
      let lastBytes = 0;
      for (let i = 0; i < ITERS; i++) {
        const payload = opt.enc(err);
        lastBytes = payload.length;
        // copy into ring
        data.set(payload, 0);
        Atomics.store(ctrl, CTRL_LEN, payload.length);
        Atomics.store(ctrl, CTRL_OPT, opt.tag);
        Atomics.add(ctrl, CTRL_REQ_SEQ, 1);
        Atomics.notify(ctrl, CTRL_REQ_SEQ, 1);
        // wait for worker to decode and ack
        Atomics.wait(ctrl, CTRL_ACK_SEQ, i);
      }
      const dtMs = performance.now() - t0;
      const usPerIter = (dtMs * 1000) / ITERS;
      console.log(
        `${opt.name} | ${sz.label.padEnd(6)} | ${usPerIter.toFixed(2).padStart(10)} | ${String(lastBytes).padStart(9)}`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Fidelity tests — done in-process (no transport) so we can check
  // what each codec preserves.
  // ────────────────────────────────────────────────────────────────

  console.log("\n=== 2. fidelity (in-process round-trip) ===");
  const custom = new CustomError("bad thing happened", "E_BAD");
  custom.extra = { hint: "look at frame 3" };

  const fidelityChecks = [
    { name: "A", roundTrip: (e) => decodeA(encodeA(e)) },
    { name: "B", roundTrip: (e) => decodeB(encodeB(e)) },
    { name: "D", roundTrip: (e) => decodeD(encodeD(e)) },
  ];

  console.log("opt | instanceof | msg ok | stack ok | name preserved | custom.code | custom.extra");
  console.log("----+------------+--------+----------+----------------+-------------+-------------");
  for (const f of fidelityChecks) {
    const r = f.roundTrip(custom);
    console.log(
      `${f.name}   | ${String(r instanceof Error).padEnd(10)} | ${String(r.message === custom.message).padEnd(6)} | ${String(r.stack === custom.stack).padEnd(8)} | ${String(r.name === "CustomError").padEnd(14)} | ${String(r.code).padEnd(11)} | ${String(r.extra)}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────────────────────────

  console.log("\n=== 3. edge cases ===");

  // 3a — circular reference on error
  const circ = new Error("circular");
  circ.self = circ;
  console.log("\n[3a] circular ref (err.self = err)");
  try { encodeB(circ); console.log("  B JSON       : ok (only name/message/stack serialized)"); }
  catch (e) { console.log("  B JSON       : THROWS —", e.message); }
  try { encodeD(circ); console.log("  D typed      : ok (only standard fields encoded)"); }
  catch (e) { console.log("  D typed      : THROWS —", e.message); }

  // 3b — BigInt prop
  const bi = new Error("with bigint");
  bi.big = 10n;
  console.log("\n[3b] BigInt prop");
  try { encodeB(bi); console.log("  B JSON       : ok (BigInt prop dropped — not in {name,message,stack})"); }
  catch (e) { console.log("  B JSON       : THROWS —", e.message); }
  try { encodeD(bi); console.log("  D typed      : ok (BigInt prop dropped)"); }
  catch (e) { console.log("  D typed      : THROWS —", e.message); }

  // 3c — Symbol-keyed prop
  const sym = new Error("with symbol");
  sym[Symbol.for("trace")] = "abc";
  console.log("\n[3c] Symbol-keyed prop");
  console.log("  all options drop Symbol-keyed props (only standard fields are read)");

  // 3d — non-Error throwable
  console.log("\n[3d] non-Error throwable (host code does `throw 'string'` or `throw 42`)");
  console.log("  all options assume an Error; non-Error must be coerced");
  console.log("  recommended: at marshal boundary do `if (!(e instanceof Error)) e = new Error(String(e))`");

  // ────────────────────────────────────────────────────────────────
  // napi-thrown error simulation
  // ────────────────────────────────────────────────────────────────

  console.log("\n=== 4. napi-thrown error path ===");
  console.log("  emnapi flow inside a wasm callback:");
  console.log("    1. callback calls napi_throw_error(env, code, msg)");
  console.log("       → sets env->last_exception, returns napi_pending_exception");
  console.log("    2. wasm op-function returns non-OK status to host");
  console.log("    3. host does napi_get_and_clear_last_exception → gets napi_value");
  console.log("    4. that napi_value is a JS object — could be Error or anything");
  console.log("    5. we must coerce to Error, then marshal via the chosen codec");
  console.log("  → in our reverse-RPC reply path, the wasm-side handler that");
  console.log("    runs the callback should:");
  console.log("      a) try { result = callback(args) }");
  console.log("      b) catch (e) { reply with status=HOST_ERROR, payload=encodeD(coerce(e)) }");
  console.log("    There's NO need to plumb napi_throw across the RPC boundary —");
  console.log("    the host worker re-throws a normal JS Error, and if the host's");
  console.log("    caller is itself a napi shim, IT calls napi_throw on the wasm side.");

  w.postMessage("done");
  await new Promise((r) => w.once("exit", r));
}

async function worker() {
  const { ctrlSab, dataSab } = workerData;
  const ctrl = new Int32Array(ctrlSab);
  const data = new Uint8Array(dataSab);

  parentPort.postMessage("ready");

  let lastReq = 0;
  let stop = false;
  parentPort.on("message", (m) => { if (m === "done") stop = true; });

  while (!stop) {
    // wait for next request (use small timeout so we can observe stop)
    const r = Atomics.wait(ctrl, CTRL_REQ_SEQ, lastReq, 50);
    if (r === "timed-out") continue;
    const newReq = Atomics.load(ctrl, CTRL_REQ_SEQ);
    if (newReq === lastReq) continue;
    lastReq = newReq;

    const len = Atomics.load(ctrl, CTRL_LEN);
    const opt = Atomics.load(ctrl, CTRL_OPT);
    const bytes = data.subarray(0, len);

    let decoded;
    switch (opt) {
      case 0: decoded = decodeA(bytes); break;
      case 1: decoded = decodeB(bytes); break;
      case 3: decoded = decodeD(bytes); break;
    }
    // touch the decoded Error so V8 can't elide work
    if (!(decoded instanceof Error)) throw new Error("decode failed");

    Atomics.add(ctrl, CTRL_ACK_SEQ, 1);
    Atomics.notify(ctrl, CTRL_ACK_SEQ, 1);
  }
  process.exit(0);
}
