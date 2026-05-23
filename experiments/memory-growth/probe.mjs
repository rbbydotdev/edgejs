// Q4 — shared memory growth coordination.
//
// When wasm calls `memory.grow(N)`:
// - Non-shared Memory: underlying ArrayBuffer is DETACHED.  All
//   existing views are invalidated.  Need to re-view on memory.buffer.
// - Shared Memory: SharedArrayBuffer cannot be detached (spec).  But
//   what happens to existing views in OTHER workers?
//
// The question: in the L5 split-worker topology, the host worker has
// `Uint8Array(wasmMemory.buffer)` for direct access.  Wasm worker
// grows the memory.  Does host's view still work?  See the new bytes?
//
// We need to know:
//   - Are existing views invalidated cross-worker?
//   - Can host see beyond the old size after wasm grows?
//   - Does emnapi's `wasmMemory.buffer` reference need rebinding?

import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";

if (isMainThread) {
  // 1 page = 64 KiB.  Initial 1, max 4.
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
  const view0 = new Uint8Array(memory.buffer);
  console.log(`[main] initial: memory.buffer.byteLength = ${memory.buffer.byteLength}`);
  console.log(`[main] initial: view0.byteLength = ${view0.byteLength}`);
  view0[0] = 0xAA;
  view0[65535] = 0xBB; // last byte of initial page

  const worker = new Worker(new URL(import.meta.url), { workerData: { memory } });
  worker.on("message", (msg) => {
    if (msg.kind === "grown") {
      console.log(`[main] worker reports grew to ${msg.newPages} pages (${msg.newBytes} bytes)`);
      console.log(`[main] after grow: memory.buffer.byteLength = ${memory.buffer.byteLength}`);
      console.log(`[main] after grow: view0.byteLength = ${view0.byteLength} (stale view)`);
      // Try to read existing bytes via the OLD view.
      try {
        console.log(`[main] view0[0] = 0x${view0[0].toString(16)} (was 0xAA)`);
        console.log(`[main] view0[65535] = 0x${view0[65535].toString(16)} (was 0xBB)`);
      } catch (e) {
        console.log(`[main] reading view0 threw: ${e.message}`);
      }
      // Try to read NEW bytes via old view.
      try {
        console.log(`[main] view0[65536] (out of old bounds) = 0x${view0[65536]?.toString(16)}`);
      } catch (e) {
        console.log(`[main] reading view0[65536] threw: ${e.message}`);
      }
      // Now make a NEW view from current memory.buffer.
      const view1 = new Uint8Array(memory.buffer);
      console.log(`[main] new view1.byteLength = ${view1.byteLength}`);
      // Read what the worker wrote in the new region.
      console.log(`[main] view1[65536] = 0x${view1[65536].toString(16)} (worker wrote 0xCC)`);
      console.log(`[main] view1[0] = 0x${view1[0].toString(16)} (was 0xAA — still there?)`);

      worker.terminate();
      process.exit(0);
    }
  });
  worker.once("error", (e) => { console.error("[main] worker error:", e); process.exit(2); });
} else {
  const { memory } = workerData;
  const v = new Uint8Array(memory.buffer);
  console.log(`[worker] initial: memory.buffer.byteLength = ${memory.buffer.byteLength}`);
  console.log(`[worker] reading main's writes: view[0]=0x${v[0].toString(16)}, view[65535]=0x${v[65535].toString(16)}`);

  // Grow by 1 page (64 KiB).
  const prevPages = memory.grow(1);
  console.log(`[worker] grew from ${prevPages} pages -> ${prevPages + 1} pages`);
  console.log(`[worker] after grow: memory.buffer.byteLength = ${memory.buffer.byteLength}`);
  console.log(`[worker] after grow: v.byteLength = ${v.byteLength} (stale view)`);

  // Try to write into the new region via OLD view (should fail or skip).
  try {
    v[65536] = 0xCC;
    console.log("[worker] wrote v[65536]=0xCC via OLD view");
  } catch (e) {
    console.log(`[worker] writing v[65536] via old view threw: ${e.message}`);
  }

  // Make a NEW view to write into the new region.
  const v1 = new Uint8Array(memory.buffer);
  v1[65536] = 0xCC;
  console.log(`[worker] wrote v1[65536]=0xCC via NEW view (v1.byteLength=${v1.byteLength})`);

  parentPort.postMessage({ kind: "grown", newPages: prevPages + 1, newBytes: memory.buffer.byteLength });
}
