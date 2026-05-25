// E36 wake verification: prove the e36 wasi-shim fix actually wakes
// poll_oneoff on uv_async_send.
//
// Test: register uv_async + ref to keep loop alive.  No timer.  At
// t=500ms, host calls uv_async_send AND uv_close on the handle.  After
// close, uv_loop_alive should return 0 → loop drains → _start exits.
//
// If wake works: _start exits shortly after t=500ms (~500-700ms total).
// If wake doesn't work: _start hangs forever (loop has no other reason
//   to iterate; the wake never wakes the parked poll), the harness
//   times out at ~25s.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workerPath = resolve(repoRoot, "browser-target", "src", "worker.ts");
const MARK = "// e36-wake-verifies probe insertion";

const BLOCK = `
  ${MARK}
  try {
    const exp = instance.exports as Record<string, unknown>;
    const uvDefaultLoop = exp["uv_default_loop"] as undefined | (() => number);
    const uvAsyncInit = exp["uv_async_init"] as undefined | ((l: number, h: number, cb: number) => number);
    const uvAsyncSend = exp["uv_async_send"] as undefined | ((h: number) => number);
    const uvClose = exp["uv_close"] as undefined | ((h: number, cb: number) => void);
    const uvHandleSize = exp["uv_handle_size"] as undefined | ((t: number) => number);
    const uvRef = exp["uv_ref"] as undefined | ((h: number) => void);
    const uvUnref = exp["uv_unref"] as undefined | ((h: number) => void);
    const guestMalloc = exp["unofficial_napi_guest_malloc"] as undefined | ((n: number) => number);
    const mem = (exp["memory"] || (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory) as WebAssembly.Memory | undefined;
    if (uvDefaultLoop && uvAsyncInit && uvAsyncSend && uvClose && uvHandleSize && uvRef && uvUnref && guestMalloc && mem) {
      const loop = uvDefaultLoop();
      const size = uvHandleSize(1);
      const h = guestMalloc(size);
      new Uint8Array(mem.buffer, h, size).fill(0);
      const initRc = uvAsyncInit(loop, h, 0);
      uvRef(h);
      post("log", { text: \`[e36-wv] keepalive engaged: init rc=\${initRc} h=\${h} t=\${Math.round(performance.now())}\`, level: "info" });
      // At t=500ms: trigger wake AND close handle.  Close requires unref+close;
      // after close, loop should consider this handle dead and uv_loop_alive
      // should return 0 (assuming no other handles — wq_async should be
      // unref'd per uv_loop_init).
      setTimeout(() => {
        const t = Math.round(performance.now());
        const sendRc = uvAsyncSend(h);
        uvUnref(h);
        uvClose(h, 0);
        post("log", { text: \`[e36-wv] send+unref+close at t=\${t} sendRc=\${sendRc}\`, level: "info" });
      }, 500);
    }
  } catch (e) {
    post("log", { text: \`[e36-wv] threw: \${(e as Error).message}\`, level: "warn" });
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

// User script: NO timers, no process.exit.  Loop should stay alive
// ONLY because of our injected uv_async keepalive.  Without wake +
// close at t=500ms, _start hangs forever.
const TEST_SCRIPT = `
console.log('[e36-wv-user] bootstrap-done t=' + Math.round(performance.now()));
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
    page.on("console", (msg) => {
      const t = msg.text();
      if (/\[e36-wv\]|\[e36-wv-user\]|_start ran/.test(t)) console.log("  >", t);
    });
    page.on("pageerror", (err) => console.log("  ! pageerror:", err.message));
    await page.goto(`http://localhost:${VITE_PORT}/?script=${encodeURIComponent(TEST_SCRIPT)}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const SENTINEL = /_start ran (\d+) ms/;
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
    console.log("\n=== E36-WAKE-VERIFIES OUTPUT ===");
    for (const l of lastLog.split("\n").filter(l => /\[e36-wv\]|\[e36-wv-user\]|_start ran/.test(l))) console.log(l);
    const sentinel = lastLog.match(/_start ran (\d+) ms/);
    if (sentinel) {
      const ms = Number(sentinel[1]);
      if (ms < 1500) {
        console.log(`\n  → PASS: wake worked.  _start exited at ${ms}ms (close at ~500ms triggered drain).`);
      } else if (ms > 20000) {
        console.log(`\n  → FAIL: wake didn't work.  _start hung at ${ms}ms (likely harness timeout).`);
      } else {
        console.log(`\n  → AMBIGUOUS: _start ran ${ms}ms.  Expected <1500 if wake works, >20000 if not.`);
      }
    } else {
      console.log("\n  → SENTINEL NOT SEEN — wasm hung past harness deadline.");
    }
    console.log("=== END E36-WAKE-VERIFIES ===\n");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
    revert(original);
  }
}

run().catch((e) => { console.error("[e36-wv] FATAL:", e); process.exitCode = 1; });
