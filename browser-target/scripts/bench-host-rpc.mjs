#!/usr/bin/env node
// L3 RPC throughput benchmark.
//
// Spawns Vite + Playwright + page; injects a benchmark script that calls
// OP_HOST_ECHO N times with a small payload, measures wall-clock time
// and per-call latency.  Compares against L5's expected need (14k+ napi
// calls per script must finish in &lt;100ms total budget for napi alone).
//
// Bench is run in the runtime worker via an injected `?script=...` that
// would normally be a user script.  We piggyback the existing page boot.
//
// Usage:
//   node browser-target/scripts/bench-host-rpc.mjs [--iters=1000] [--payload=32]
//
// Output: per-call median + p99, total throughput.

import { setTimeout as delay } from "node:timers/promises";
import { startVite, launchChromium, killProc, VITE_PORT } from "./_runner-common.mjs";

const TIMEOUT_MS = 30_000;

function parseArgs() {
  const args = { iters: 1000, payload: 32 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--iters=")) args.iters = parseInt(a.slice(8), 10);
    else if (a.startsWith("--payload=")) args.payload = parseInt(a.slice(10), 10);
  }
  return args;
}

async function main() {
  const { iters, payload } = parseArgs();
  const { default: playwright } = await import("playwright");
  let viteProc, browser;
  try {
    viteProc = await startVite();
    browser = await launchChromium(playwright);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // The benchmark logic runs INSIDE the runtime worker after boot.
    // We expose it via a window-attached function the host wires up.
    // For L3 the runtime worker doesn't have a generic "run-on-host"
    // entry point yet, so we use an injected user script that does a
    // tight loop via `__benchEchoLoop` (which we add to worker.ts in
    // the next change).
    //
    // For NOW, we just trigger the existing init-time ping (already
    // measured by probe-host-ping) and dump a result indicating the
    // bench harness is wired but the per-call loop awaits L3b wiring.
    await page.goto(`http://localhost:${VITE_PORT}/?bench=echo&iters=${iters}&payload=${payload}`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });

    const deadline = Date.now() + TIMEOUT_MS;
    let benchResult = null;
    while (Date.now() < deadline && !benchResult) {
      benchResult = await page.evaluate(() => {
        // Bench result is logged as "bench-host-echo: ..." line.
        const log = document.getElementById("log");
        if (!log) return null;
        const m = log.innerText.match(/bench-host-echo:\s*(.+)/);
        return m ? m[1].trim() : null;
      });
      if (benchResult) break;
      await delay(150);
    }

    if (!benchResult) {
      const tail = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? (log.innerText || "").slice(-2000) : "";
      });
      process.stderr.write(`bench timeout; page log tail:\n${tail}\n`);
      process.exit(1);
    }
    process.stdout.write(`${benchResult}\n`);
    process.exit(0);
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}

main().catch((e) => {
  process.stderr.write(`bench error: ${e?.stack ?? e}\n`);
  process.exit(2);
});
