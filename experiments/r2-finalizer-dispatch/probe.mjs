// R2 — finalizer dispatch across the host/wasm split.
//
// Topology mirrors Lever B's planned full-napi-cutover:
//
//   Main thread = "wasm worker"
//     - Simulates wasm code that calls `napi_add_finalizer(env, jsVal,
//       finalize_cb, hint)`. The finalize_cb is conceptually a wasm
//       table funcref; here we model it as an integer "fnptr".
//     - Receives reverse-channel messages from host when host's GC
//       reclaims one of the JS values it registered.
//
//   Worker thread = "host worker"
//     - Owns the JS values + the FinalizationRegistry. (In real life:
//       the host's V8 isolate.)
//     - Creates the JS values (objects), holds them strongly while
//       wasm "uses" them, then drops references and `global.gc()`s.
//     - When FinalizationRegistry fires, posts a reverse-channel
//       message back to the wasm worker carrying the fnptr + hint.
//
// Validates:
//   1. Can FinalizationRegistry observe at least 10 GCs deterministically
//      under --expose-gc + forced cycles?
//   2. What order do finalizers fire in? FIFO (registration order),
//      LIFO, or indeterminate?
//   3. If only N of M registered values are dropped, do exactly N
//      finalizers fire?
//   4. Are finalizers batched (all fire in one microtask drain) or
//      trickled (one per tick)?
//   5. How long between `global.gc()` and the registry callbacks?
//   6. What happens if the reverse channel is "busy" when host wants
//      to fire? (Modeled by wasm doing synchronous work; host MUST
//      keep its registry queue draining either way.)
//
// Note: FinalizationRegistry is best-effort per spec; the entire
// experiment is "does V8's actual behavior give us enough determinism
// to wire this in production?"

import { Worker, isMainThread, parentPort } from "node:worker_threads";

const TOTAL_VALUES = 12;        // register this many finalizers
const KEEP_ALIVE = 3;           // keep refs to this many (so only TOTAL-KEEP get GC'd)
const GC_CYCLES = 5;            // force GC this many times to flush registry

if (isMainThread) {
  // ── Wasm side ──
  // 1. Spawn host worker.
  // 2. Send N "register finalizer" requests (fake napi_add_finalizer).
  // 3. Wait for reverse-channel "finalize" messages.
  // 4. Print findings.

  const fired = [];           // {fnptr, hint, t} in arrival order
  const startedAt = Date.now();
  let registryGcAt = 0;       // when host claims GC fired

  // Note: node won't accept --expose-gc as an execArgv override on a
  // Worker (only a few flags are whitelisted). We instead pass it on
  // the parent process via package.json's "node --expose-gc" script,
  // and propagate by default via execArgv inheritance.
  const worker = new Worker(new URL(import.meta.url));

  worker.on("message", (msg) => {
    if (msg.kind === "ready") {
      // Send the register-finalizer batch.
      for (let i = 0; i < TOTAL_VALUES; i++) {
        worker.postMessage({
          kind: "register",
          fnptr: 1000 + i,       // pretend wasm-table index
          hint: i,               // user-supplied opaque
          keepAlive: i < KEEP_ALIVE,
        });
      }
      worker.postMessage({ kind: "drop-and-gc" });
    } else if (msg.kind === "finalize") {
      // Reverse-channel: host says one of our finalizers needs to fire.
      // In real life: wasm dynCall(fnptr)(env, data, hint).
      fired.push({ fnptr: msg.fnptr, hint: msg.hint, t: Date.now() - startedAt });
    } else if (msg.kind === "gc-done") {
      registryGcAt = Date.now() - startedAt;
      // Give the registry one more macrotask to flush, then report.
      setTimeout(() => {
        report();
        worker.terminate();
      }, 50);
    } else if (msg.kind === "log") {
      console.log(`[host] ${msg.text}`);
    }
  });

  worker.on("error", (e) => {
    console.error("[wasm] host worker error:", e);
    process.exit(2);
  });

  function report () {
    console.log("");
    console.log("=== R2 results ===");
    console.log(`registered:           ${TOTAL_VALUES}`);
    console.log(`kept alive:           ${KEEP_ALIVE}`);
    console.log(`expected to fire:     ${TOTAL_VALUES - KEEP_ALIVE}`);
    console.log(`actually fired:       ${fired.length}`);
    console.log(`host gc completed at: +${registryGcAt}ms`);
    if (fired.length > 0) {
      console.log(`first finalizer at:   +${fired[0].t}ms`);
      console.log(`last finalizer at:    +${fired[fired.length - 1].t}ms`);
      console.log(`gap between first and last: ${fired[fired.length - 1].t - fired[0].t}ms`);
    }
    console.log("");
    console.log("fired sequence (hint values — registration order was 0..N-1, KEEP_ALIVE first kept):");
    console.log(`  ${fired.map(f => f.hint).join(", ")}`);

    // Ordering check: hints should all be in [KEEP_ALIVE, TOTAL_VALUES).
    const expected = new Set();
    for (let i = KEEP_ALIVE; i < TOTAL_VALUES; i++) expected.add(i);
    const got = new Set(fired.map(f => f.hint));
    const missing = [...expected].filter(h => !got.has(h));
    const extra = [...got].filter(h => !expected.has(h));
    console.log(`missing finalizers:   ${missing.length === 0 ? "none" : missing.join(",")}`);
    console.log(`unexpected finalizers: ${extra.length === 0 ? "none" : extra.join(",")}`);

    // FIFO vs LIFO vs neither.
    const hints = fired.map(f => f.hint);
    const sortedAsc = [...hints].sort((a, b) => a - b);
    const sortedDesc = [...hints].sort((a, b) => b - a);
    if (hints.length >= 2) {
      if (hints.every((h, i) => h === sortedAsc[i])) {
        console.log("ordering:             FIFO (registration order)");
      } else if (hints.every((h, i) => h === sortedDesc[i])) {
        console.log("ordering:             LIFO (reverse registration)");
      } else {
        console.log("ordering:             INDETERMINATE (neither FIFO nor LIFO)");
      }
    }

    // Batching: how many distinct timestamps?
    const distinctTs = new Set(fired.map(f => f.t));
    console.log(`distinct firing ticks: ${distinctTs.size} (1 = batched, N = trickled)`);

    const pass = fired.length === (TOTAL_VALUES - KEEP_ALIVE);
    console.log("");
    console.log(`PASS: ${pass}`);
    process.exitCode = pass ? 0 : 1;
  }

  // Safety timeout — only fires if the happy path never runs.
  const timeoutHandle = setTimeout(() => {
    console.error("[wasm] timeout — never saw all expected finalizers");
    report();
    worker.terminate();
  }, 10_000);
  timeoutHandle.unref();
} else {
  // ── Host side (worker thread) ──

  if (typeof globalThis.gc !== "function") {
    parentPort.postMessage({ kind: "log", text: "FATAL: global.gc is not exposed; package.json must pass --expose-gc" });
    process.exit(3);
  }

  // The actual FinalizationRegistry on the "host". When a JS value is
  // GC'd, V8 calls this with the heldValue we registered alongside.
  //
  // heldValue = { fnptr, hint } — the bits needed for the reverse
  // RPC back to wasm.
  const registry = new FinalizationRegistry((held) => {
    parentPort.postMessage({ kind: "finalize", fnptr: held.fnptr, hint: held.hint });
  });

  // Hold values strongly until told to drop. Without this, the values
  // might be eligible for collection between create() and registry.register().
  let liveValues = [];
  const keepForever = []; // these are the "kept alive" ones, never dropped

  parentPort.on("message", (msg) => {
    if (msg.kind === "register") {
      // Create a fresh JS object — this represents the host-side JS
      // value the wasm code wrapped (e.g. via napi_create_object +
      // napi_add_finalizer).
      const jsVal = { tag: `obj-${msg.hint}` };

      // Register with the FinalizationRegistry. Note: we MUST use a
      // separate "unregister token" if we ever want to cancel —
      // skipping for simplicity here.
      registry.register(jsVal, { fnptr: msg.fnptr, hint: msg.hint });

      if (msg.keepAlive) {
        keepForever.push(jsVal); // strong ref → never GC'd
      } else {
        liveValues.push(jsVal);  // strong ref for now; dropped below
      }
    } else if (msg.kind === "drop-and-gc") {
      parentPort.postMessage({ kind: "log", text: `dropping ${liveValues.length} refs, keeping ${keepForever.length}` });

      // Drop all strong refs to the "should-be-collected" values.
      liveValues.length = 0;
      liveValues = null; // also kill the binding

      // V8 finalizer dispatch quirk: registry callbacks fire in a
      // microtask AFTER GC, not synchronously during. So we cycle GC
      // + yield several times to flush.
      (async () => {
        for (let i = 0; i < GC_CYCLES; i++) {
          globalThis.gc();
          // Yield so registry's queued microtask can drain.
          await new Promise(r => setImmediate(r));
        }
        parentPort.postMessage({ kind: "gc-done" });
      })();
    }
  });

  parentPort.postMessage({ kind: "ready" });
}
