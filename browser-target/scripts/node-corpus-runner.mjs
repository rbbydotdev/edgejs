#!/usr/bin/env node
// Run Node.js test corpus tests (test/parallel/*.js) through the browser
// target: Vite + Playwright Chromium + edge.wasm in a DedicatedWorker.
//
// How it works:
//   - The bundled FS adapter already serves /test/** from
//     browser-target/public/test (symlink to repo's ./test).
//   - For each test, we generate a tiny driver that does
//     `require('/test/parallel/<name>')` and prints a sentinel.
//   - Driver passes via ?script=... URL like the existing harness.
//   - We compare expected ↔ actual using the test's own assertions
//     (success = no thrown error + clean exit).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  testsDir as edgeTestsDir,
  VITE_PORT,
  TEST_TIMEOUT_MS,
  startVite,
  launchChromium,
  killProc,
} from "./_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const nodeTestsDir = resolve(repoRoot, "test", "parallel");

const SENTINEL_RE = /_start ran \d+ ms \((exit=(-?\d+)|THREW|returned)\)/;

function loadList(filter) {
  const tests = readdirSync(nodeTestsDir)
    .filter((f) => f.endsWith(".js") && f.startsWith("test-"))
    .filter((f) => !filter || f.includes(filter))
    .sort();
  return tests;
}

function buildDriver(testName) {
  // The browser-target runtime doesn't propagate process.exit() codes
  // through to the _start sentinel (TerminateExecution unwinds without
  // an ExitSignal), so we can't rely on exit codes. Instead, print
  // unambiguous PASS/FAIL markers to stdout that the harness greps.
  return `
    process.on('uncaughtException', (e) => {
      console.log('[CORPUS-RESULT] FAIL uncaught: ' + (e && e.stack || String(e)).split('\\n')[0]);
      process.exit(1);
    });
    process.on('unhandledRejection', (r) => {
      console.log('[CORPUS-RESULT] FAIL unhandled: ' + (r && r.stack || String(r)).split('\\n')[0]);
      process.exit(1);
    });
    try {
      require('/test/parallel/${testName}');
      console.log('[CORPUS-RESULT] PASS');
      process.exit(0);
    } catch (e) {
      console.log('[CORPUS-RESULT] FAIL sync: ' + (e && e.stack || String(e)).split('\\n')[0]);
      console.error((e && e.stack) || String(e));
      process.exit(1);
    }
  `;
}

async function runOne(browser, testName) {
  const driver = buildDriver(testName);
  const url = `http://localhost:${VITE_PORT}/?script=${encodeURIComponent(driver)}`;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleLogs = [];
  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${err.message}`));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const deadline = Date.now() + TEST_TIMEOUT_MS;
    let sentinel = null;
    while (Date.now() < deadline) {
      sentinel = await page.evaluate((re) => {
        const log = document.getElementById("log");
        if (!log) return null;
        // Match LAST occurrence (edgejs.wasm), not first (hello.wasm smoke).
        const matches = [...log.innerText.matchAll(new RegExp(re, "g"))];
        if (matches.length === 0) return null;
        const m = matches[matches.length - 1];
        return { matched: m[0], exit: m[1] === "THREW" || m[1] === "returned" ? null : Number(m[2]) };
      }, SENTINEL_RE.source);
      if (sentinel) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!sentinel) {
      return { status: "timeout", logs: consoleLogs.slice(-5).join("\n") };
    }
    // Browser-target's _start sentinel can't propagate process.exit codes
    // reliably -- TerminateExecution unwinds without ExitSignal so we
    // get "(returned)". Instead, our driver emits an explicit
    // [CORPUS-RESULT] PASS/FAIL marker we grep for.
    const result = await page.evaluate(() => {
      const log = document.getElementById("log");
      if (!log) return { passed: false, line: "no-log" };
      const matches = [...log.innerText.matchAll(/\[CORPUS-RESULT\] (PASS|FAIL[^\n]*)/g)];
      if (matches.length === 0) return { passed: false, line: "no-marker" };
      const last = matches[matches.length - 1];
      return { passed: last[1] === "PASS", line: last[1] };
    });
    if (!result.passed) {
      // Capture lvl-out (stdout) + lvl-err (stderr) separately so we see
      // the actual JS error, not the wasi syscall trace.
      const out = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return { stdout: "", stderr: "", fullTail: "" };
        const outs = Array.from(log.querySelectorAll(".lvl-out")).map(e => e.innerText).join("");
        const errs = Array.from(log.querySelectorAll(".lvl-err, .lvl-warn")).map(e => e.innerText).join("");
        const fullTail = log.innerText.split("\n").slice(-40).join("\n");
        return { stdout: outs, stderr: errs, fullTail };
      });
      return { status: "fail", reason: result.line, exit: sentinel.exit, stdout: out.stdout, stderr: out.stderr, fullTail: out.fullTail };
    }
    return { status: "pass" };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const filter = process.argv[2] || "";
  const list = loadList(filter);
  if (list.length === 0) {
    console.log("no tests matched");
    return;
  }
  const limit = Number(process.env.LIMIT || 0) || list.length;
  const tests = list.slice(0, limit);
  console.log(`node-corpus-runner: ${tests.length} test(s)`);

  let viteProc = null;
  let browser = null;
  try {
    viteProc = await startVite();
    browser = await launchChromium();

    let pass = 0, fail = 0, timeout = 0;
    const failures = [];
    for (const t of tests) {
      try {
        const r = await runOne(browser, t);
        switch (r.status) {
          case "pass": pass++; process.stdout.write("."); break;
          case "fail": fail++; process.stdout.write("F"); failures.push({ t, ...r }); break;
          case "timeout": timeout++; process.stdout.write("T"); failures.push({ t, ...r }); break;
        }
      } catch (e) {
        fail++;
        failures.push({ t, status: "err", err: e.message });
        process.stdout.write("E");
      }
    }
    console.log(`\n\n${pass} pass, ${fail} fail, ${timeout} timeout`);
    if (failures.length > 0 && failures.length < 30) {
      console.log("\n=== failures ===");
      for (const f of failures.slice(0, 10)) {
        console.log(`\n--- ${f.t} (${f.status}${f.exit != null ? `, exit=${f.exit}` : ""}) ---`);
        if (f.stderr) console.log("STDERR:\n" + f.stderr.slice(-2000));
        if (f.stdout) console.log("STDOUT:\n" + f.stdout.slice(-1000));
        if (f.err) console.log(f.err);
        if (!f.stderr && !f.stdout && f.fullTail) console.log("TAIL:\n" + f.fullTail);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 1; });
