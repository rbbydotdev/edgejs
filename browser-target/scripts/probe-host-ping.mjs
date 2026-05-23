#!/usr/bin/env node
// L2 host-worker ping probe.  Spawns Vite + Playwright, loads the page,
// scrapes the #log DOM for the two markers:
//   "host worker ready"           (host worker booted + posted ready)
//   "[runtime] host ping ok ..."  (wasm worker successfully ping'd host)
//
// Exits 0 on both seen, 1 otherwise.  No test fixture; just boots and waits.

import { setTimeout as delay } from "node:timers/promises";
import { startVite, launchChromium, killProc, VITE_PORT } from "./_runner-common.mjs";

const TIMEOUT_MS = 20_000;

async function main() {
  const { default: playwright } = await import("playwright");
  let viteProc, browser;
  try {
    viteProc = await startVite();
    browser = await launchChromium(playwright);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: "domcontentloaded", timeout: 10_000 });

    const deadline = Date.now() + TIMEOUT_MS;
    let sawReady = false;
    let sawPing = false;
    while (Date.now() < deadline && !(sawReady && sawPing)) {
      const found = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return { ready: false, ping: false, snippet: "" };
        const text = log.innerText || "";
        return {
          ready: text.includes("host worker ready"),
          ping: /host ping ok\s+status=\d+\s+replyBytes=\d+/.test(text),
          snippet: text.slice(-500),
        };
      });
      sawReady = found.ready;
      sawPing = found.ping;
      if (sawReady && sawPing) break;
      await delay(150);
    }

    if (sawReady && sawPing) {
      process.stdout.write("probe-host-ping: OK (host ready + ping round-trip)\n");
      process.exit(0);
    }
    const tail = await page.evaluate(() => {
      const log = document.getElementById("log");
      return log ? (log.innerText || "").slice(-2000) : "";
    });
    process.stderr.write(
      `probe-host-ping: FAIL — sawReady=${sawReady} sawPing=${sawPing}\n` +
      `page #log tail (last 2KB):\n${tail}\n`,
    );
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}

main().catch((e) => {
  process.stderr.write(`probe-host-ping: error ${e?.stack ?? e}\n`);
  process.exit(2);
});
