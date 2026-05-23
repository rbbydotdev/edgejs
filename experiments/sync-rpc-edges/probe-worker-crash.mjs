// Q5.A — what happens when wasm worker crashes mid-RPC?
//
// In L5, host issues sync RPC and calls Atomics.wait for reply.  If
// the wasm worker crashes (or `worker.terminate()`), the wait never
// resolves.  Host hangs forever unless we time out.
//
// Test:
//   - Host sends an RPC to worker.
//   - Worker exits immediately without responding.
//   - Host's Atomics.wait should time out cleanly.
//   - Verify we can detect the worker is dead and report a sensible
//     error to the caller (instead of hanging).

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";

const TIMEOUT_MS = 1_000;

if (isMainThread) {
  const ctrlSab = new SharedArrayBuffer(32);
  const ctrl = new Int32Array(ctrlSab);

  let workerDead = false;
  const worker = new Worker(new URL(import.meta.url), { workerData: { ctrlSab } });
  worker.on("exit", (code) => {
    console.log(`[main] worker exited (code=${code})`);
    workerDead = true;
  });
  worker.once("error", (e) => console.error("[main] worker error:", e));

  // Tell worker to start (it'll exit immediately as designed).
  await new Promise((r) => setTimeout(r, 50));

  // Issue an "RPC": store req=1, notify, then wait for reply.
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0, 1);
  console.log("[main] issued RPC; waiting for reply with 1s timeout...");

  const t0 = Date.now();
  const result = Atomics.wait(ctrl, 1, 0, TIMEOUT_MS);
  const elapsed = Date.now() - t0;
  console.log(`[main] Atomics.wait returned "${result}" after ${elapsed}ms`);

  if (result === "timed-out" && workerDead) {
    console.log("[main] OK — detected worker death via timeout + exit event");
    console.log("[main] Recovery: host can throw a controlled error to the napi caller");
    process.exit(0);
  } else if (result === "timed-out") {
    console.log("[main] Timeout fired but worker.exit hasn't been observed yet");
    // Wait briefly for exit event.
    await new Promise((r) => setTimeout(r, 100));
    if (workerDead) {
      console.log("[main] OK — worker exit confirmed");
      process.exit(0);
    } else {
      console.log("[main] FAIL — worker hung, neither dead nor responsive");
      worker.terminate();
      process.exit(1);
    }
  } else {
    console.log("[main] UNEXPECTED — got non-timeout result");
    process.exit(1);
  }
} else {
  console.log("[worker] starting; will exit immediately without processing any RPC");
  // No-op; worker exits when the script ends.
  process.exit(0);
}
