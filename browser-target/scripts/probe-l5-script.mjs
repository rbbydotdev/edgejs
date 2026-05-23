#!/usr/bin/env node
// L5 spike: run a Promise.then ordering test via host-V8 eval and verify
// Node-correct ordering.  Proves microtasks drain naturally on host
// worker (vs. the wasm worker where they don't).

import { setTimeout as delay } from "node:timers/promises";
import { startVite, launchChromium, killProc, VITE_PORT } from "./_runner-common.mjs";

const SCRIPT = `
  const order = [];
  Promise.resolve().then(() => order.push('a'));
  Promise.resolve().then(() => order.push('b'));
  queueMicrotask(() => order.push('c'));
  await Promise.resolve();
  console.log(order.join(','));
`;

const EXPECTED = "a,b,c";

async function main() {
  const { default: playwright } = await import("playwright");
  let viteProc, browser;
  try {
    viteProc = await startVite();
    browser = await launchChromium(playwright);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Use ?l5script= to trigger host-side eval (we wire this in main.ts).
    const url = `http://localhost:${VITE_PORT}/?l5script=${encodeURIComponent(SCRIPT)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });

    const deadline = Date.now() + 15_000;
    let result = null;
    while (Date.now() < deadline && !result) {
      result = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = log.innerText.match(/l5-script-result:\s*(.*)/);
        return m ? m[1].trim() : null;
      });
      if (result) break;
      await delay(150);
    }
    if (!result) {
      const tail = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? (log.innerText || "").slice(-2000) : "";
      });
      process.stderr.write(`l5 timeout; tail:\n${tail}\n`);
      process.exit(1);
    }
    if (result === EXPECTED) {
      process.stdout.write(`probe-l5-script: OK got "${result}" (matches Node-correct)\n`);
      process.exit(0);
    } else {
      process.stderr.write(`probe-l5-script: FAIL expected "${EXPECTED}" got "${result}"\n`);
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
