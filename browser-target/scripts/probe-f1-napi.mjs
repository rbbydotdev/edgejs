#!/usr/bin/env node
// F-1 probe: first napi op via RPC end-to-end in main project.
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
    await page.goto(`http://localhost:${VITE_PORT}/?probe=f1-napi`, {
      waitUntil: "domcontentloaded", timeout: 10_000,
    });
    const deadline = Date.now() + 15_000;
    let line = null;
    while (Date.now() < deadline && !line) {
      line = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = log.innerText.match(/f1-napi-probe:\s*(OK|FAIL)/);
        return m ? m[1] : null;
      });
      if (line) break;
      await delay(150);
    }
    const tail = await page.evaluate(() => {
      const log = document.getElementById("log");
      return log ? (log.innerText || "").slice(-1500) : "";
    });
    if (line === "OK") {
      process.stdout.write(`probe-f1-napi: OK\n---\n${tail.split("\n").filter((l) => l.includes("f1-napi")).join("\n")}\n`);
      process.exit(0);
    }
    process.stderr.write(`probe-f1-napi: ${line ?? "TIMEOUT"}\n${tail}\n`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}
main().catch((e) => { process.stderr.write(`error: ${e?.stack ?? e}\n`); process.exit(2); });
