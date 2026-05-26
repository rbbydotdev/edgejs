// e41 probe runner: launches the probe test through the existing
// browser harness (Vite + Playwright Chromium) and captures the full
// stdout including [e41] diagnostic lines.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const probePath = process.argv[2] || resolve(here, "probe-1-reallyexit.js");
const script = readFileSync(probePath, "utf8");

async function run() {
  let viteProc = null;
  let browser = null;
  try {
    viteProc = await startVite();
    browser = await launchChromium();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));

    const url = `http://localhost:${VITE_PORT}/?script=${encodeURIComponent(script)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    const SENTINEL = /_start ran \d+ ms/;
    const deadline = Date.now() + 15_000;
    let text = "";
    while (Date.now() < deadline) {
      text = await page.evaluate(() => document.getElementById("log")?.innerText ?? "");
      if (SENTINEL.test(text)) break;
      await new Promise(r => setTimeout(r, 100));
    }

    console.log("=== E41 PROBE OUTPUT ===");
    for (const l of text.split("\n")) {
      if (/\[e41\]|_start ran|caught:|handler did not/.test(l)) console.log(l);
    }
    console.log("=== END E41 ===");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
  }
}

run().catch((e) => { console.error("[e41] FATAL:", e); process.exitCode = 1; });
