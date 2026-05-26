// e41 probe runner with full console capture (incl wasm stderr)
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

    const consoleLines = [];
    page.on("console", (msg) => consoleLines.push(`[console.${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

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

    // Wait a bit for late stderr to flush
    await new Promise(r => setTimeout(r, 500));

    console.log("=== STDOUT (DOM) ===");
    for (const l of text.split("\n")) {
      if (/\[e41\]|_start ran|caught:|handler did not/.test(l)) console.log(l);
    }
    console.log("\n=== STDERR (DOM, includes C++ fprintf) ===");
    for (const l of text.split("\n")) {
      if (/\[e41-c\+\+\]|\[e41\]/.test(l)) console.log(l);
    }
    console.log("\n=== FULL DOM (last 100 lines) ===");
    const lines = text.split("\n");
    for (const l of lines.slice(-100)) console.log(l);
    console.log("\n=== CONSOLE ===");
    for (const l of consoleLines) {
      if (/\[e41-c\+\+\]|\[e41\]/.test(l)) console.log(l);
    }
    console.log("=== END ===");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
  }
}

run().catch((e) => { console.error("FATAL:", e); process.exitCode = 1; });
