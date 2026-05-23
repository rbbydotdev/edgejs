#!/usr/bin/env node
// L8 spike: verify import-map + blob URL pattern works in Chromium for
// virtual `node:fs` resolution.  Loads /index-l8.html, scrapes #out.

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
    await page.goto(`http://localhost:${VITE_PORT}/l8-test.html`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });
    const deadline = Date.now() + 10_000;
    let out = null;
    while (Date.now() < deadline && !out) {
      out = await page.evaluate(() => {
        const el = document.getElementById("out");
        if (!el) return null;
        const txt = el.textContent || "";
        return /l8-spike-result:/.test(txt) ? txt : null;
      });
      if (out) break;
      await delay(150);
    }
    if (!out) {
      const tail = await page.evaluate(() => document.getElementById("out")?.textContent ?? "");
      process.stderr.write(`probe-l8-importmap: timeout; out:\n${tail}\n`);
      process.exit(1);
    }
    if (/l8-spike-result:\s*OK/.test(out)) {
      process.stdout.write(`probe-l8-importmap: OK\n---\n${out}---\n`);
      process.exit(0);
    } else {
      process.stderr.write(`probe-l8-importmap: FAIL\n---\n${out}---\n`);
      process.exit(1);
    }
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}

main().catch((e) => {
  process.stderr.write(`probe error: ${e?.stack ?? e}\n`);
  process.exit(2);
});
