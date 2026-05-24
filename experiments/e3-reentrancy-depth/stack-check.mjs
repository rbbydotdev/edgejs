// Tiny utility: count how deep a trivial recursion goes before stack overflow,
// both on the main thread and inside a worker thread.  Used to verify whether
// `--stack-size` propagates to workers.

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

function countMain() {
  let n = 0;
  function r() { n++; r(); }
  try { r(); } catch { return n; }
  return n;
}

if (isMainThread) {
  const mainDepth = countMain();
  console.log(`main thread cliff: ${mainDepth} frames`);
  const w = new Worker(new URL(import.meta.url), { workerData: {} });
  w.on("message", (m) => {
    console.log(`worker thread cliff: ${m.depth} frames`);
    process.exit(0);
  });
} else {
  parentPort.postMessage({ depth: countMain() });
}
