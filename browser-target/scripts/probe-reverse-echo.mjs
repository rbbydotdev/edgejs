#!/usr/bin/env node
// L4 reverse-channel proof of life.  Spawns Vite + Chromium, loads
// page with ?probe=reverse-echo, scrapes #log DOM for the marker.

import { setTimeout as delay } from "node:timers/promises";
import { startVite, launchChromium, killProc, VITE_PORT } from "./_runner-common.mjs";

const TIMEOUT_MS = 15_000;

async function main() {
  const { default: playwright } = await import("playwright");
  let viteProc, browser;
  try {
    viteProc = await startVite();
    browser = await launchChromium(playwright);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/?probe=reverse-echo`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });
    const deadline = Date.now() + TIMEOUT_MS;
    let result = null;
    while (Date.now() < deadline && !result) {
      result = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = log.innerText.match(/reverse-echo:\s*ok\s+(\d+)B in ([\d.]+)ms/);
        return m ? { bytes: parseInt(m[1], 10), ms: parseFloat(m[2]) } : null;
      });
      if (result) break;
      await delay(150);
    }
    if (!result) {
      const tail = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? (log.innerText || "").slice(-2000) : "";
      });
      process.stderr.write(`probe-reverse-echo: timeout; tail:\n${tail}\n`);
      process.exit(1);
    }
    process.stdout.write(`probe-reverse-echo: OK ${result.bytes}B round-trip in ${result.ms}ms\n`);
    process.exit(0);
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}

main().catch((e) => {
  process.stderr.write(`probe error: ${e?.stack ?? e}\n`);
  process.exit(2);
});
