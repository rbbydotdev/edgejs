#!/usr/bin/env node
// F-2 probe: wasm runtime worker reads host's emnapi-written handles
// via the shared napi memory SAB.  Cross-worker memory bridge proof.
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
    await page.goto(`http://localhost:${VITE_PORT}/`, {
      waitUntil: "domcontentloaded", timeout: 10_000,
    });
    const deadline = Date.now() + 20_000;
    let line = null;
    while (Date.now() < deadline && !line) {
      line = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = log.innerText.match(/f2-mem-probe:.*?-> (OK|FAIL)/);
        return m ? m[0] : null;
      });
      if (line) break;
      await delay(200);
    }
    if (line && line.endsWith("OK")) {
      process.stdout.write(`probe-f2-mem-bridge: ${line}\n`);
      process.exit(0);
    }
    const full = await page.evaluate(() => {
      const log = document.getElementById("log");
      return log ? (log.innerText || "") : "";
    });
    const runtimeLines = full.split("\n").filter((l) => l.includes("runtime]") || l.includes("f2-mem"));
    process.stderr.write(`probe-f2-mem-bridge: ${line ?? "TIMEOUT"}\nruntime lines:\n${runtimeLines.join("\n")}\n---tail:---\n${full.slice(-1500)}\n`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}
main().catch((e) => { process.stderr.write(`error: ${e?.stack ?? e}\n`); process.exit(2); });
