// E37 — Does uv_run(UV_RUN_DEFAULT) block on a ref'd async handle?
//
// Method: Inject keepalive (uv_async_init + uv_ref) BEFORE _start runs.
// User script has a 10s safety timer (process.exit(2)).  Host schedules
// send+close at t=500ms.
//
// Three outcomes (success criteria from README):
//   _start ran ~500ms, exit=0    →  keepalive + wake both work
//   _start ran ~10_000ms, exit=2 →  keepalive works, wake doesn't
//   _start ran < 100ms, exit=0   →  keepalive doesn't engage at all

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workerPath = resolve(repoRoot, "browser-target", "src", "worker.ts");
const MARK = "// e37 probe insertion";

const BLOCK = `
  ${MARK}
  try {
    const exp = instance.exports as Record<string, unknown>;
    const uvDefaultLoop = exp["uv_default_loop"] as undefined | (() => number);
    const uvLoopAlive = exp["uv_loop_alive"] as undefined | ((l: number) => number);
    const uvAsyncInit = exp["uv_async_init"] as undefined | ((l: number, h: number, cb: number) => number);
    const uvAsyncSend = exp["uv_async_send"] as undefined | ((h: number) => number);
    const uvClose = exp["uv_close"] as undefined | ((h: number, cb: number) => void);
    const uvRef = exp["uv_ref"] as undefined | ((h: number) => void);
    const uvHandleSize = exp["uv_handle_size"] as undefined | ((t: number) => number);
    const guestMalloc = exp["unofficial_napi_guest_malloc"] as undefined | ((n: number) => number);
    const mem = (exp["memory"] || (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory) as WebAssembly.Memory | undefined;
    if (uvDefaultLoop && uvLoopAlive && uvAsyncInit && uvAsyncSend && uvClose && uvRef && uvHandleSize && guestMalloc && mem) {
      const loop = uvDefaultLoop();
      const size = uvHandleSize(1);
      const h = guestMalloc(size);
      new Uint8Array(mem.buffer, h, size).fill(0);
      const initRc = uvAsyncInit(loop, h, 0);
      uvRef(h);
      const aliveAfterRef = uvLoopAlive(loop);
      const t0 = Math.round(performance.now());
      post("log", { text: \`[e37] keepalive init rc=\${initRc} alive_after_ref=\${aliveAfterRef} t=\${t0}\`, level: "info" });

      // Probe alive state at several timepoints during _start to see
      // whether something un-refs or closes our handle.
      setTimeout(() => {
        const t = Math.round(performance.now());
        const a = uvLoopAlive(loop);
        post("log", { text: \`[e37] @t=\${t} alive=\${a} (probe-50ms)\`, level: "info" });
      }, 50);
      setTimeout(() => {
        const t = Math.round(performance.now());
        const a = uvLoopAlive(loop);
        post("log", { text: \`[e37] @t=\${t} alive=\${a} (probe-200ms)\`, level: "info" });
      }, 200);

      // Schedule send+close at host t+500ms.
      setTimeout(() => {
        const tSend = Math.round(performance.now());
        const aliveBeforeClose = uvLoopAlive(loop);
        const sendRc = uvAsyncSend(h);
        uvClose(h, 0);
        const aliveAfterClose = uvLoopAlive(loop);
        post("log", { text: \`[e37] @t=\${tSend}: pre-close alive=\${aliveBeforeClose} send rc=\${sendRc} post-close alive=\${aliveAfterClose}\`, level: "info" });
      }, 500);

      (globalThis as { __e37Handle?: number }).__e37Handle = h;
    }
  } catch (e) {
    post("log", { text: \`[e37] probe threw: \${(e as Error).message}\`, level: "warn" });
  }
`;

function patch() {
  const src = readFileSync(workerPath, "utf8");
  if (src.includes(MARK)) throw new Error("already patched");
  const anchor = `post("log", { text: "emnapi bound; running _start…", level: "info" });`;
  writeFileSync(workerPath, src.replace(anchor, `${anchor}\n${BLOCK}`), "utf8");
}

function revert(original) {
  writeFileSync(workerPath, original, "utf8");
}

// User script has NO timers — only the probe's uv_async_t keepalive
// keeps the loop alive.  Outcomes:
//   _start exits ~500ms       → keepalive + wake both work (close drained at 500ms)
//   _start exits < 100ms      → keepalive did not engage
//   _start times out (~25s)   → keepalive holds but wake doesn't fire (loop stays parked)
//
// The harness's 25s deadline IS the safety net — no in-script timer
// (which would itself be a uv_timer_t keepalive and confound the test).
const TEST_SCRIPT = `
console.log('[e37-user] bootstrap-done t=' + Math.round(performance.now()));
`;

async function run() {
  const original = readFileSync(workerPath, "utf8");
  let viteProc = null;
  let browser = null;
  try {
    patch();
    viteProc = await startVite();
    browser = await launchChromium();
    const page = await browser.newPage();
    const pageLogs = [];
    page.on("console", (msg) => {
      const t = msg.text();
      if (/\[e37\]|\[e37-user\]|_start ran|emnapi bound/.test(t)) {
        console.log("  >", t);
        pageLogs.push(t);
      }
    });
    page.on("pageerror", (err) => console.log("  ! pageerror:", err.message));
    await page.goto(`http://localhost:${VITE_PORT}/?script=${encodeURIComponent(TEST_SCRIPT)}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const SENTINEL = /_start ran (\d+) ms \((exit=(-?\d+)|THREW|returned)\)/;
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
    console.log("\n=== E37 PROBE OUTPUT ===");
    for (const l of lastLog.split("\n").filter(l => /\[e37\]|\[e37-user\]|_start ran/.test(l))) console.log(l);
    const m = lastLog.match(SENTINEL);
    if (!m) {
      console.log("\n  → KEEPALIVE HOLDS, WAKE DOES NOT FIRE.  Loop parked past 25s deadline (no sentinel).");
    } else {
      const ms = Number(m[1]);
      const exitStr = m[2];
      console.log(`\n  raw: ms=${ms} exit=${exitStr}`);
      if (ms < 100) {
        console.log("  → KEEPALIVE DID NOT ENGAGE.  Loop drained immediately.");
      } else if (ms > 400 && ms < 2000) {
        console.log("  → KEEPALIVE + WAKE BOTH WORK.  uv_close at t=500ms drained the loop.");
      } else {
        console.log(`  → AMBIGUOUS: ms=${ms} exit=${exitStr}.  Need methodology refinement.`);
      }
    }
    console.log("=== END E37 PROBE ===\n");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
    revert(original);
  }
}

run().catch((e) => { console.error("[e37] FATAL:", e); process.exitCode = 1; });
