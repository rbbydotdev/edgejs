// E35 — Empirical probe: why doesn't uv_async_t keep _start's
// uv_run from returning in our wasi-libuv build?
//
// See README.md for hypothesis tree.  This probe patches worker.ts
// in-place with a diagnostic block, runs through Vite + Chromium,
// scrapes [e35] log lines, then reverts worker.ts.
//
// The probe injects two phases:
//
//   1. AFTER-BIND (sync, before _start): tests A and B — does
//      uv_async_init + uv_ref make uv_loop_alive return non-zero?
//      Probes both NULL cb and a non-NULL cb (an existing wasm
//      funcref whose signature happens to match (i32)→void).
//
//   2. DURING-START (timed, while _start is running): tests C —
//      after some delay, host calls uv_async_send on the handle.
//      A setImmediate is scheduled BEFORE the send via the existing
//      reverse-RPC funcref invoker so we can measure the latency
//      between send and dispatch.  Skipped if wake isn't expected
//      to work (hypothesis 1).
//
// Test script keeps _start alive for ~1s with a setTimeout so the
// during-start probe can run during real loop activity.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workerPath = resolve(repoRoot, "browser-target", "src", "worker.ts");

const PROBE_MARKER = "// e35 probe insertion";

// Diagnostic block — runs AFTER `napi.bindInstance(...)` succeeds,
// BEFORE _start.  loop->wq_async has been init'd by uv_loop_init at
// __wasm_call_ctors, so uv_loop_alive should already be 1 here.  We
// confirm that, then add our own async handles and see if the count
// changes / loop stays alive.
//
// IMPORTANT: a non-zero baseline (wq_async keeping the loop alive
// from the start) would mean the keepalive WAS already engaged before
// our policy ran, and the bug is elsewhere (e.g., wq_async gets
// unref'd somewhere, or RunEventLoopUntilQuiescent has its own exit
// path).  That's the key signal to watch for.
const PROBE_BLOCK = `
  ${PROBE_MARKER}
  try {
    const exp = instance.exports as Record<string, unknown>;
    const uvDefaultLoop = exp["uv_default_loop"] as undefined | (() => number);
    const uvLoopAlive = exp["uv_loop_alive"] as undefined | ((l: number) => number);
    const uvHandleSize = exp["uv_handle_size"] as undefined | ((t: number) => number);
    const uvAsyncInit = exp["uv_async_init"] as undefined | ((l: number, h: number, cb: number) => number);
    const uvAsyncSend = exp["uv_async_send"] as undefined | ((h: number) => number);
    const uvRef = exp["uv_ref"] as undefined | ((h: number) => void);
    const guestMalloc = exp["unofficial_napi_guest_malloc"] as undefined | ((n: number) => number);
    const indirectTable = exp["__indirect_function_table"] as undefined | WebAssembly.Table;
    const mem = (exp["memory"] || (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory) as WebAssembly.Memory | undefined;

    if (!uvDefaultLoop || !uvLoopAlive || !uvHandleSize || !uvAsyncInit ||
        !uvAsyncSend || !uvRef || !guestMalloc || !mem) {
      post("log", { text: \`[e35] missing exports — abort\`, level: "warn" });
    } else {
      const loop = uvDefaultLoop();
      const size = uvHandleSize(1); // UV_ASYNC

      // === BASELINE ===
      const aliveBaseline = uvLoopAlive(loop);
      post("log", { text: \`[e35] BASELINE uv_loop_alive(loop=\${loop}) = \${aliveBaseline}  (expected 1 if wq_async counts)\`, level: "info" });

      // === TEST A: NULL cb ===
      const hA = guestMalloc(size);
      new Uint8Array(mem.buffer, hA, size).fill(0);
      const initRcA = uvAsyncInit(loop, hA, 0);
      const aliveAfterInitA = uvLoopAlive(loop);
      uvRef(hA);
      const aliveAfterRefA = uvLoopAlive(loop);
      post("log", { text: \`[e35] TEST A (cb=0): init rc=\${initRcA} alive_after_init=\${aliveAfterInitA} alive_after_ref=\${aliveAfterRefA}\`, level: "info" });

      // === TEST B: non-NULL cb (probe the indirect table for any
      // function with signature (i32)→void).  We just try funcref
      // index 1 — historically that's a builtin (often something like
      // __cxa_pure_virtual or __do_nothing).  If it traps when
      // invoked, the loop won't fire it unless we call uv_async_send.
      // For the keepalive question (does uv_loop_alive return 1?), the
      // cb is never invoked — so even a wrong-type funcref is fine.
      let cbIndex = 0;
      if (indirectTable) {
        // Iterate to find first non-null entry — likely a real function.
        for (let i = 1; i < Math.min(20, indirectTable.length); i++) {
          const fn = indirectTable.get(i);
          if (typeof fn === "function") { cbIndex = i; break; }
        }
      }
      const hB = guestMalloc(size);
      new Uint8Array(mem.buffer, hB, size).fill(0);
      const initRcB = uvAsyncInit(loop, hB, cbIndex);
      const aliveAfterInitB = uvLoopAlive(loop);
      uvRef(hB);
      const aliveAfterRefB = uvLoopAlive(loop);
      post("log", { text: \`[e35] TEST B (cb=\${cbIndex}): init rc=\${initRcB} alive_after_init=\${aliveAfterInitB} alive_after_ref=\${aliveAfterRefB}\`, level: "info" });

      // === Stash for TEST C: during-start wake-up timing ===
      (globalThis as { __e35Probe?: unknown }).__e35Probe = {
        loop, hA, hB, uvAsyncSend, uvLoopAlive,
        sendTimestamps: [],
      };

      // === TEST C: schedule a wake during _start.
      // Setup: send uv_async_send(hA) at +400ms (after _start has
      // started running and is likely parked in poll_oneoff waiting
      // for the user-script's 1000ms timer).  If the loop wakes
      // immediately, the wake mechanism works.  If it waits until the
      // 1000ms timer fires, wake is broken.
      setTimeout(() => {
        try {
          const p = (globalThis as { __e35Probe?: { hA: number; hB: number; uvAsyncSend: (h: number) => number; uvLoopAlive: (l: number) => number; loop: number; sendTimestamps: number[] } }).__e35Probe;
          if (!p) return;
          const aliveBeforeSend = p.uvLoopAlive(p.loop);
          const tSend = performance.now();
          p.sendTimestamps.push(tSend);
          const sendRcA = p.uvAsyncSend(p.hA);
          const sendRcB = p.uvAsyncSend(p.hB);
          post("log", { text: \`[e35] TEST C (t=\${tSend.toFixed(0)}ms): pre-send alive=\${aliveBeforeSend} send(hA) rc=\${sendRcA} send(hB) rc=\${sendRcB}\`, level: "info" });
        } catch (e) {
          post("log", { text: \`[e35] TEST C send threw: \${(e as Error).message}\`, level: "warn" });
        }
      }, 400);
    }
  } catch (probeErr) {
    post("log", { text: \`[e35] probe-after-bind threw: \${(probeErr as Error).message}\`, level: "warn" });
  }
`;

function patchWorker() {
  const src = readFileSync(workerPath, "utf8");
  if (src.includes(PROBE_MARKER)) {
    throw new Error("worker.ts already has e35 probe markers — refusing to patch twice");
  }
  const bindAnchor = `post("log", { text: "emnapi bound; running _start…", level: "info" });`;
  if (!src.includes(bindAnchor)) {
    throw new Error("could not find bindInstance anchor in worker.ts");
  }
  const patched = src.replace(bindAnchor, `${bindAnchor}\n${PROBE_BLOCK}`);
  writeFileSync(workerPath, patched, "utf8");
}

function revertWorker(original) {
  writeFileSync(workerPath, original, "utf8");
}

// Test script — keep _start alive ~1.2s so the during-start probe
// at +400ms has a meaningful chance to wake.  Also log timestamps
// before+after the chained setTimeout so we can measure whether
// `uv_async_send` actually wakes anything.
const PROBE_TEST_SCRIPT = `
console.log('[e35-user] t=' + Math.round(performance.now()) + ' bootstrap-start');
setTimeout(() => {
  console.log('[e35-user] t=' + Math.round(performance.now()) + ' timer-1000ms fired');
  process.exit(0);
}, 1000);
`;

async function runProbe() {
  console.log("[e35] reading worker.ts…");
  const original = readFileSync(workerPath, "utf8");

  let viteProc = null;
  let browser = null;
  try {
    console.log("[e35] patching worker.ts…");
    patchWorker();
    console.log("[e35] starting vite…");
    viteProc = await startVite();
    console.log("[e35] launching chromium…");
    browser = await launchChromium();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (/\[e35\]|\[e35-user\]|_start ran/.test(t)) {
        console.log("  >", t);
      }
    });
    page.on("pageerror", (err) => {
      console.log("  ! pageerror:", err.message);
    });
    const enc = encodeURIComponent(PROBE_TEST_SCRIPT);
    const url = "http://localhost:" + VITE_PORT + "/?script=" + enc;
    console.log("[e35] navigating…");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    const SENTINEL = /_start ran \d+ ms/;
    const deadline = Date.now() + 25_000;
    let lastLog = "";
    while (Date.now() < deadline) {
      lastLog = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? log.innerText : "";
      });
      if (SENTINEL.test(lastLog)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const probeLines = lastLog.split("\n").filter(l => /\[e35\]|\[e35-user\]/.test(l));
    console.log("\n=== E35 PROBE OUTPUT ===");
    for (const l of probeLines) console.log(l);
    const sentinel = lastLog.match(/_start ran[^\n]+/);
    console.log("[e35] sentinel:", sentinel ? sentinel[0] : "(not seen — wasm may have hung)");
    console.log("=== END E35 PROBE ===\n");
    if (!probeLines.length) {
      console.log("[e35] (no probe lines; first 2KB of log):");
      console.log(lastLog.slice(0, 2000));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
    console.log("[e35] reverting worker.ts…");
    revertWorker(original);
  }
}

runProbe().catch((e) => {
  console.error("[e35] FATAL:", e);
  process.exitCode = 1;
});
