// Q1.A — Reproduce the malloc re-entrancy deadlock.
//
// Scenario: the L5 split-worker topology has wasm on worker A, emnapi
// context on worker B (this main thread / host).  Wasm calls a napi
// op that internally needs to malloc wasm-side memory.  The malloc
// proxy on host RPCs back to wasm worker.  Wasm worker is BLOCKED in
// Atomics.wait waiting for the napi reply.  Deadlock.
//
// This probe sets up a minimal version of that exact scenario using
// Node's worker_threads.  We expect it to time out (= deadlock confirmed).
//
// Simulating the RPC primitive:
//   - One SAB shared with the worker.
//   - Worker writes status=1 (request pending) at slot 0, calls
//     Atomics.wait on it.  Waits for status=2 (reply ready).
//   - Main reads the request, decides "this op needs malloc", tries to
//     send a malloc request to the worker (status at slot 1).  Worker
//     can't respond — it's in Atomics.wait at slot 0.
//   - Both sides time out.

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const TIMEOUT_MS = 2_000;

// Slot indices in the shared SAB (Int32 indices, not bytes).
const REQ_STATUS = 0;        // worker → main: 1 = request pending
const REPLY_STATUS = 1;      // main → worker: 2 = reply ready
const MALLOC_REQ_STATUS = 2; // main → worker: 1 = malloc request pending
const MALLOC_REPLY_STATUS = 3; // worker → main: 2 = malloc reply ready

if (isMainThread) {
  const sab = new SharedArrayBuffer(32);
  const i32 = new Int32Array(sab);
  const worker = new Worker(new URL(import.meta.url), { workerData: { sab } });
  worker.once("error", (e) => console.error("[main] worker error:", e));

  // Wait for the worker's RPC request (status=1 at slot 0).
  const t0 = Date.now();
  let sawRequest = false;
  while (Date.now() - t0 < TIMEOUT_MS) {
    if (Atomics.load(i32, REQ_STATUS) === 1) {
      sawRequest = true;
      break;
    }
    Atomics.wait(i32, REQ_STATUS, 0, 100);
  }

  if (!sawRequest) {
    console.log("[main] FAIL: never saw the worker's request");
    worker.terminate();
    process.exit(1);
  }
  console.log("[main] received worker's napi request — now needs malloc from worker");

  // Try to issue a malloc request to the worker.  Worker is blocked
  // in Atomics.wait on REPLY_STATUS (slot 1).  It WILL NOT see our
  // MALLOC_REQ_STATUS change.
  Atomics.store(i32, MALLOC_REQ_STATUS, 1);
  Atomics.notify(i32, MALLOC_REQ_STATUS, 1); // wasted — no waiter on this slot

  // Wait for malloc reply.  Won't come.
  console.log("[main] waiting for malloc reply from worker (will deadlock)...");
  const mallocResult = Atomics.wait(i32, MALLOC_REPLY_STATUS, 0, TIMEOUT_MS);
  console.log(`[main] Atomics.wait for malloc reply returned: ${mallocResult}`);

  if (mallocResult === "timed-out") {
    console.log("[main] DEADLOCK CONFIRMED — main timed out waiting for malloc reply");
    console.log("[main]   (worker is still blocked in its own Atomics.wait for the napi reply)");
  } else {
    console.log("[main] UNEXPECTED — worker somehow responded");
  }

  worker.terminate();
  process.exit(0);
} else {
  const sab = workerData.sab;
  const i32 = new Int32Array(sab);

  // Step 1: post a "napi request" (status=1 at slot 0).
  Atomics.store(i32, REQ_STATUS, 1);
  Atomics.notify(i32, REQ_STATUS, 1);

  // Step 2: wait for reply (status=2 at slot 1).  This is where the
  // wasm worker would be blocked, in real life, during a napi call.
  const waitResult = Atomics.wait(i32, REPLY_STATUS, 0, TIMEOUT_MS);
  console.log(`[worker] Atomics.wait for napi reply returned: ${waitResult}`);
}
