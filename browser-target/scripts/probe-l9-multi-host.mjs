#!/usr/bin/env node
// L9 spike: verify multi-host-worker spawn + per-host routing.
import { setTimeout as delay } from "node:timers/promises";
import { startVite, launchChromium, killProc, VITE_PORT } from "./_runner-common.mjs";

async function main() {
  const { default: playwright } = await import("playwright");
  let viteProc, browser;
  try {
    viteProc = await startVite();
    browser = await launchChromium(playwright);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/?probe=l9-multi-host`, {
      waitUntil: "domcontentloaded", timeout: 10_000,
    });
    const deadline = Date.now() + 15_000;
    let line = null;
    while (Date.now() < deadline && !line) {
      line = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = log.innerText.match(/l9-multi-host:\s*(.+)/);
        return m ? m[1].trim() : null;
      });
      if (line) break;
      await delay(150);
    }
    if (!line) {
      const tail = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? (log.innerText || "").slice(-2000) : "";
      });
      process.stderr.write(`probe-l9-multi-host: timeout\n${tail}\n`);
      process.exit(1);
    }
    if (line.startsWith("OK")) {
      process.stdout.write(`probe-l9-multi-host: ${line}\n`);
      process.exit(0);
    }
    process.stderr.write(`probe-l9-multi-host: ${line}\n`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}
main().catch((e) => { process.stderr.write(`probe error: ${e?.stack ?? e}\n`); process.exit(2); });
