#!/usr/bin/env node
// F-9 sweep probe: exercises one representative napi op per batch via
// real SAB-RPC end-to-end against the host worker.  Smoke test —
// catches gross wiring errors after the F-9 batch additions.
//
// Triggered by ?probe=f9-sweep; main.ts's runF9SweepProbe() drives
// the actual calls.  This script just waits for the summary line and
// reports pass/fail.
import { setTimeout as delay } from "node:timers/promises";
import { startVite, launchChromium, killProc, VITE_PORT } from "./_runner-common.mjs";

async function main() {
  let viteProc, browser;
  try {
    viteProc = await startVite();
    browser = await launchChromium();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/?probe=f9-sweep`, {
      waitUntil: "domcontentloaded", timeout: 10_000,
    });
    const deadline = Date.now() + 40_000;
    let summary = null;
    while (Date.now() < deadline && !summary) {
      summary = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = (log.innerText || "").match(/f9-sweep:\s*(\d+)\/(\d+)\s+ops OK\s+—\s+(OK|FAIL)/);
        return m ? { pass: Number(m[1]), total: Number(m[2]), verdict: m[3] } : null;
      });
      if (summary) break;
      await delay(150);
    }
    const tail = await page.evaluate(() => {
      const log = document.getElementById("log");
      return log ? (log.innerText || "").slice(-3000) : "";
    });
    const sweepLines = tail.split("\n").filter((l) => l.startsWith("f9-sweep") || l.includes("DIAG") || l.includes("MODULE LOAD") || l.includes("napi context ready")).join("\n");
    if (summary && summary.verdict === "OK") {
      process.stdout.write(`probe-f9-sweep: OK  (${summary.pass}/${summary.total} ops)\n---\n${sweepLines}\n`);
      process.exit(0);
    }
    process.stderr.write(`probe-f9-sweep: ${summary ? `FAIL (${summary.pass}/${summary.total})` : "TIMEOUT"}\n---\n${sweepLines || tail}\n`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}
main().catch((e) => { process.stderr.write(`error: ${e?.stack ?? e}\n`); process.exit(2); });
