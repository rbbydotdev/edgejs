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

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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

/** Extract the module-family bucket from a test filename.
 *  `test-fs-promises-readfile.js` → `fs`
 *  `test-event-emitter-foo.js`    → `events`
 *  `test-zlib-bytes-read.js`      → `zlib`
 *  Special cases: `test-async-hooks-*` → `async_hooks`, `test-perf-hooks-*` →
 *  `perf_hooks`, `test-child-process-*` → `child_process`,
 *  `test-worker-*` → `worker_threads`, `test-string-decoder-*` →
 *  `string_decoder`, `test-event-*` and `test-events-*` → `events`. */
function bucketFor(name) {
  // Strip "test-" prefix + ".js"/".mjs" suffix to get the body.
  const body = name.replace(/^test-/, "").replace(/\.(js|mjs|cjs)$/, "");
  // Multi-word module families.  Order matters — longest first.
  const multiWord = [
    ["async-hooks-", "async_hooks"],
    ["perf-hooks-", "perf_hooks"],
    ["child-process-", "child_process"],
    ["string-decoder-", "string_decoder"],
    ["diagnostics-channel-", "diagnostics_channel"],
    ["trace-events-", "trace_events"],
    ["readline-promises-", "readline_promises"],
    ["fs-promises-", "fs_promises"],
    ["timers-promises-", "timers_promises"],
  ];
  for (const [prefix, bucket] of multiWord) {
    if (body.startsWith(prefix)) return bucket;
  }
  // Single-word.  test-event-* and test-events-* both → events.
  if (body.startsWith("event-") || body.startsWith("events-") || body === "events") return "events";
  if (body.startsWith("worker-")) return "worker_threads";
  // First hyphen-delimited segment is the bucket.
  const m = /^([a-z][a-z0-9]*)(?:-|$)/.exec(body);
  return m ? m[1] : "_misc";
}

function aggregateByBucket(results) {
  const buckets = new Map();
  for (const r of results) {
    const b = bucketFor(r.test);
    let agg = buckets.get(b);
    if (!agg) {
      agg = { bucket: b, pass: 0, fail: 0, timeout: 0, total: 0, failingTests: [] };
      buckets.set(b, agg);
    }
    agg.total++;
    if (r.status === "pass") agg.pass++;
    else if (r.status === "timeout") { agg.timeout++; agg.failingTests.push(r.test); }
    else { agg.fail++; agg.failingTests.push(r.test); }
  }
  return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function writeJsonResults(jsonPath, results, startedAt, finishedAt) {
  mkdirSync(dirname(jsonPath), { recursive: true });
  const aggregates = aggregateByBucket(results);
  const summary = {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    totalTests: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail" || r.status === "err").length,
    timeout: results.filter((r) => r.status === "timeout").length,
    perBucket: aggregates.map((a) => ({
      bucket: a.bucket,
      pass: a.pass,
      fail: a.fail,
      timeout: a.timeout,
      total: a.total,
      passRate: a.total === 0 ? 0 : Math.round((a.pass / a.total) * 10000) / 100,
    })),
    results,
  };
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

function writeMarkdownSummary(mdPath, summary) {
  const lines = [];
  lines.push("# Node Test Corpus Pass Rates (edgejs-web)");
  lines.push("");
  lines.push("Auto-generated by `browser-target/scripts/node-corpus-runner.mjs`.");
  lines.push("");
  lines.push(`* Started: ${new Date(summary.startedAt).toISOString()}`);
  lines.push(`* Finished: ${new Date(summary.finishedAt).toISOString()}`);
  lines.push(`* Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  lines.push(`* Total: ${summary.totalTests} (pass ${summary.pass} / fail ${summary.fail} / timeout ${summary.timeout})`);
  const rate = summary.totalTests === 0 ? 0 : Math.round((summary.pass / summary.totalTests) * 10000) / 100;
  lines.push(`* Overall pass rate: **${rate}%**`);
  lines.push("");
  lines.push("## Per-module pass rates");
  lines.push("");
  lines.push("| Module | Pass | Fail | Timeout | Total | Pass rate |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const b of summary.perBucket) {
    lines.push(`| \`${b.bucket}\` | ${b.pass} | ${b.fail} | ${b.timeout} | ${b.total} | ${b.passRate}% |`);
  }
  lines.push("");
  lines.push("Source: `corpus-results.json` (same dir).");
  writeFileSync(mdPath, lines.join("\n") + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith("--")) || "";
  const outDir = (args.find((a) => a.startsWith("--out="))?.slice(6)) || resolve(repoRoot, "corpus");
  const list = loadList(filter);
  if (list.length === 0) {
    console.log("no tests matched");
    return;
  }
  const limit = Number(process.env.LIMIT || 0) || list.length;
  const tests = list.slice(0, limit);
  console.log(`node-corpus-runner: ${tests.length} test(s); out=${outDir}`);

  const startedAt = Date.now();
  const results = [];
  let viteProc = null;
  let browser = null;
  try {
    viteProc = await startVite();
    browser = await launchChromium();

    let pass = 0, fail = 0, timeout = 0;
    const failures = [];
    for (const t of tests) {
      let entry;
      try {
        const r = await runOne(browser, t);
        entry = { test: t, ...r };
        switch (r.status) {
          case "pass": pass++; process.stdout.write("."); break;
          case "fail": fail++; process.stdout.write("F"); failures.push({ t, ...r }); break;
          case "timeout": timeout++; process.stdout.write("T"); failures.push({ t, ...r }); break;
        }
      } catch (e) {
        fail++;
        entry = { test: t, status: "err", reason: e.message };
        failures.push({ t, status: "err", err: e.message });
        process.stdout.write("E");
      }
      results.push(entry);
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

  const finishedAt = Date.now();
  const summary = writeJsonResults(resolve(outDir, "corpus-results.json"), results, startedAt, finishedAt);
  writeMarkdownSummary(resolve(outDir, "corpus-summary.md"), summary);
  console.log(`\nwrote ${outDir}/corpus-results.json + corpus-summary.md`);
  console.log("\n=== per-bucket pass rates ===");
  for (const b of summary.perBucket) {
    console.log(`  ${b.bucket.padEnd(20)} ${b.pass}/${b.total} (${b.passRate}%)`);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 1; });
