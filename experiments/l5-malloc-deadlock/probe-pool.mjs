// Q1.B — Solution A: pre-allocated bump pool, no RPC for malloc.
//
// At boot, wasm worker reserves a large region of its linear memory
// (e.g., 16 MB) and exports its base pointer.  Host gets the base.
// During emnapi calls, when emnapi needs to malloc, host's malloc
// proxy uses a JS-side bump allocator.  No RPC.  No deadlock.
//
// Tradeoffs:
//   ✓ Zero RPC overhead for allocations
//   ✓ Simple — bump allocator is ~10 LOC
//   ✓ No re-entrancy risk
//   ✗ No real free() — region grows monotonically until reset
//   ✗ Pool can be exhausted; needs sizing
//   ✗ Doesn't help for ops that need malloc+free patterns mid-call
//
// This probe simulates the same scenario as probe-reproduce.mjs but
// with the pool resolution applied.  Expected: napi call succeeds,
// malloc completes via pool, no deadlock.

import { Worker, isMainThread, workerData } from "node:worker_threads";

const TIMEOUT_MS = 2_000;
const POOL_SIZE = 16 * 1024 * 1024;
const POOL_BASE = 1024;  // bytes; leave room for "stack" / other usage

const REQ_STATUS = 0;
const REPLY_STATUS = 1;
const REPLY_RESULT = 2; // we'll write the allocated ptr here

if (isMainThread) {
  // Simulate the wasm worker's linear memory as a SAB the worker
  // pre-fills with the reserved pool region.  Main has direct access.
  const memSab = new SharedArrayBuffer(POOL_SIZE + 4 * 1024);
  const memU8 = new Uint8Array(memSab);
  const ctlSab = new SharedArrayBuffer(32);
  const ctl = new Int32Array(ctlSab);

  // JS-side bump allocator on host.  In production, this lives in
  // the host worker's emnapi malloc proxy.  State (poolNext) is
  // host-only — no SAB needed.
  let poolNext = POOL_BASE;
  function hostPoolMalloc(size) {
    // 8-byte align.
    const aligned = (size + 7) & ~7;
    const ptr = poolNext;
    poolNext += aligned;
    if (poolNext > POOL_BASE + POOL_SIZE) {
      throw new Error(`pool exhausted: tried to alloc ${size} starting at ${ptr}; pool end is ${POOL_BASE + POOL_SIZE}`);
    }
    return ptr;
  }

  const worker = new Worker(new URL(import.meta.url), {
    workerData: { memSab, ctlSab },
  });
  worker.once("error", (e) => console.error("[main] worker error:", e));

  // Wait for worker's napi request.
  const t0 = Date.now();
  let sawRequest = false;
  while (Date.now() - t0 < TIMEOUT_MS) {
    if (Atomics.load(ctl, REQ_STATUS) === 1) { sawRequest = true; break; }
    Atomics.wait(ctl, REQ_STATUS, 0, 100);
  }
  if (!sawRequest) {
    console.log("[main] FAIL: never saw the worker's request");
    worker.terminate();
    process.exit(1);
  }
  console.log("[main] received worker's napi request — needs malloc");

  // KEY DIFFERENCE: we DON'T RPC to worker for malloc.  We use the
  // host-side pool allocator.  No deadlock possible.
  const allocSize = 4096;
  const ptr = hostPoolMalloc(allocSize);
  console.log(`[main] pool-allocated ${allocSize} bytes at ptr=${ptr}`);

  // Write a marker into the allocated region so the worker can verify.
  // We have direct access to the shared memory.
  for (let i = 0; i < 8; i++) {
    memU8[ptr + i] = 0xAA;
  }
  console.log("[main] wrote 8 bytes of 0xAA at the allocated region");

  // Send the reply: status=2, result=ptr.
  Atomics.store(ctl, REPLY_RESULT, ptr);
  Atomics.store(ctl, REPLY_STATUS, 2);
  Atomics.notify(ctl, REPLY_STATUS, 1);

  // Wait for worker to verify + complete.
  worker.once("message", (msg) => {
    if (msg === "verified") {
      console.log("[main] worker verified the pool-allocated region");
      console.log("[main] DEADLOCK RESOLVED via pool — pool now at offset", poolNext);
      worker.terminate();
      process.exit(0);
    } else {
      console.log("[main] worker reported:", msg);
      worker.terminate();
      process.exit(1);
    }
  });
} else {
  const { memSab, ctlSab } = workerData;
  const memU8 = new Uint8Array(memSab);
  const ctl = new Int32Array(ctlSab);

  // Post napi request.
  Atomics.store(ctl, REQ_STATUS, 1);
  Atomics.notify(ctl, REQ_STATUS, 1);

  // Wait for napi reply (= host has pool-allocated and written).
  const waitResult = Atomics.wait(ctl, REPLY_STATUS, 0, TIMEOUT_MS);
  if (waitResult === "timed-out") {
    parentPort.postMessage("timed-out");
    process.exit(1);
  }

  // Read result ptr; verify the bytes host wrote.
  const ptr = Atomics.load(ctl, REPLY_RESULT);
  let ok = true;
  for (let i = 0; i < 8; i++) {
    if (memU8[ptr + i] !== 0xAA) { ok = false; break; }
  }
  if (ok) {
    parentPort.postMessage("verified");
  } else {
    parentPort.postMessage("byte-mismatch");
  }
}

// Worker needs parentPort import — available via worker_threads.
import { parentPort } from "node:worker_threads";
