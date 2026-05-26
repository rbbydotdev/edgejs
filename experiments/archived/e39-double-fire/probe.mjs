// E39 — diagnose why unhandledRejection handler fires twice with the
// wasi-shim line-1122 fix applied.
//
// Method: instrument the test script's handler to log call # + stack +
// promise identity, so we can see whether (a) the same promise emits
// twice or (b) two distinct emissions happen.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// Mimics the failing test exactly but adds counter + post-exit log.
const TEST_SCRIPT = `
let count = 0;
process.on('unhandledRejection', (reason) => {
  count++;
  console.log('[e39] handler-call=' + count + ' t=' + Math.round(performance.now()) + ' reason=' + reason);
  process.exit(0);
  console.log('[e39] AFTER process.exit(0) — should never see this');
});
Promise.reject(new Error('boom'));
setTimeout(() => {
  console.log('[e39] timer-100ms fired t=' + Math.round(performance.now()) + ' handler-called=' + count + '×');
  process.exit(1);
}, 100);
`;

async function run() {
  let viteProc = null;
  let browser = null;
  try {
    viteProc = await startVite();
    browser = await launchChromium();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (/\[e39\]|_start ran/.test(t)) console.log(t);
    });
    page.on("pageerror", (err) => console.log("! pageerror:", err.message));
    await page.goto(`http://localhost:${VITE_PORT}/?script=${encodeURIComponent(TEST_SCRIPT)}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const SENTINEL = /_start ran \d+ ms/;
    const deadline = Date.now() + 15_000;
    let lastLog = "";
    while (Date.now() < deadline) {
      lastLog = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? log.innerText : "";
      });
      if (SENTINEL.test(lastLog)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    console.log("\n=== E39 PROBE OUTPUT ===");
    for (const l of lastLog.split("\n").filter(l => /\[e39\]|_start ran/.test(l))) console.log(l);
    console.log("=== END E39 ===\n");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
  }
}

run().catch((e) => { console.error("[e39] FATAL:", e); process.exitCode = 1; });
