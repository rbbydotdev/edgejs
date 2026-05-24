#!/usr/bin/env node
// B / scope-op forwarding probe runner.  Drives ?probe=scope-bounded
// in the browser, scrapes main.ts's `runScopeBoundedProbe` summary.
//
// What it validates:
//   1. OP_NAPI_OPEN_HANDLE_SCOPE / OP_NAPI_CLOSE_HANDLE_SCOPE handlers
//      are wired and actually open/close scopes on the host's emnapi.
//   2. OP_NAPI_DEBUG_HANDLE_STORE_SIZE returns a real handle-count
//      metric that shrinks when scopes close.
//   3. Looping (open → alloc → close) keeps the host handleStore size
//      bounded, while looping (alloc-only) grows it linearly.  Confirms
//      both the fix works and the unfixed path actually leaks.
import { setTimeout as delay } from "node:timers/promises";
import { startVite, launchChromium, killProc, VITE_PORT } from "./_runner-common.mjs";

async function main() {
  let viteProc, browser;
  try {
    viteProc = await startVite();
    browser = await launchChromium();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/?probe=scope-bounded`, {
      waitUntil: "domcontentloaded", timeout: 10_000,
    });
    const deadline = Date.now() + 40_000;
    let verdict = null;
    while (Date.now() < deadline && verdict === null) {
      verdict = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = (log.innerText || "").match(/scope-bounded:\s+(OK|FAIL)\s+\(/);
        return m ? m[1] : null;
      });
      if (verdict) break;
      await delay(150);
    }
    const tail = await page.evaluate(() => {
      const log = document.getElementById("log");
      return log ? (log.innerText || "").slice(-3000) : "";
    });
    const probeLines = tail.split("\n").filter((l) => l.startsWith("scope-bounded")).join("\n");
    if (verdict === "OK") {
      process.stdout.write(`probe-scope-bounded: OK\n---\n${probeLines}\n`);
      process.exit(0);
    }
    process.stderr.write(`probe-scope-bounded: ${verdict === "FAIL" ? "FAIL" : "TIMEOUT"}\n---\n${probeLines || tail}\n`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}
main().catch((e) => { process.stderr.write(`error: ${e?.stack ?? e}\n`); process.exit(2); });
