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
void readFileSync; void existsSync;
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
const knownFailuresPath = resolve(here, "..", "known-failures.json");

const SENTINEL_RE = /_start ran \d+ ms \((exit=(-?\d+)|THREW|returned)\)/;

// Load known-failure manifest. See browser-target/known-failures.json for
// the schema + category refs.  Each entry: testName → { category, expectedFailure? }.
// Classification:
//   PASS                — test passed (expected)
//   FAIL                — failed AND not in manifest → real regression
//   KNOWN-FAIL          — failed AND matches manifest entry (substring match
//                          against expectedFailure if provided, else any failure)
//   KNOWN-FAIL-CHANGED  — failed AND in manifest BUT failure signature differs
//                          from expectedFailure → diagnostic alert
//   UNEXPECTED-PASS     — passed AND in manifest → improvement, prompts cleanup
function loadKnownFailures() {
  let raw;
  try { raw = readFileSync(knownFailuresPath, "utf8"); }
  catch (_e) { return { tests: {}, categories: {} }; }
  try {
    const j = JSON.parse(raw);
    return { tests: j.tests || {}, categories: j["$category-refs"] || {} };
  } catch (e) {
    console.warn(`[known-failures] parse failed: ${e.message}`);
    return { tests: {}, categories: {} };
  }
}

function classifyResult(r, manifest) {
  const entry = manifest.tests[r.test];
  if (r.status === "pass") {
    return entry ? { state: "UNEXPECTED-PASS", category: entry.category } : { state: "PASS" };
  }
  if (!entry) return { state: "FAIL" };
  // If manifest has no expectedFailure specifier, ANY failure is accepted.
  if (!entry.expectedFailure) {
    return { state: "KNOWN-FAIL", category: entry.category };
  }
  // Substring match on stderr / stdout / reason.
  const haystack = [r.reason || "", r.stderr || "", r.stdout || ""].join("\n").toLowerCase();
  const needle = String(entry.expectedFailure).toLowerCase();
  if (haystack.includes(needle)) {
    return { state: "KNOWN-FAIL", category: entry.category };
  }
  return {
    state: "KNOWN-FAIL-CHANGED",
    category: entry.category,
    expected: entry.expectedFailure,
    actualReason: r.reason,
  };
}

function loadList(filter) {
  const tests = readdirSync(nodeTestsDir)
    .filter((f) => f.endsWith(".js") && f.startsWith("test-"))
    .filter((f) => !filter || f.includes(filter))
    .sort();
  return tests;
}

// buildDriver — keep the returned template literal LEAN.  The script gets
// URL-encoded into a `?script=` query param and there's an empirical
// ~2150-char URL-encoded cliff in the transport (see exit-experiments
// agent report 2026-05-30 in commit history): drivers larger than that
// fail to make forward progress past the `[override] matched node:vm`
// stage — the wasm boots but never executes.  Comments INSIDE the
// template inflate the URL; keep them OUT here.
//
// Design notes (don't inline these in the template):
//   - PASS / FAIL markers are scraped from stdout by runOne() — the
//     _start sentinel can't carry the exit code because process.exit()
//     uses TerminateExecution which doesn't propagate.
//   - process.exit() throws a __edgeExitSignal sentinel (from the
//     process-exit-terminates preset) so the catch handles common.skip
//     correctly.
//   - exit is deferred via an UNREF'd 5s watchdog: with
//     poll-wake-on-schedule shipping, the libuv loop drains naturally
//     for sync + async work alike, and the unref'd timer doesn't keep
//     the loop alive — so when work IS done, _start exits well within
//     5s.  The watchdog catches genuine leaked-handle cases.
function buildDriver(testName) {
  return `
    function isExitSignal(e) {
      return e && typeof e === 'object' && e.__edgeExitSignal === true;
    }
    var exitArmed = false;
    function deferredExit(code) {
      if (exitArmed) return;
      exitArmed = true;
      process.exitCode = code | 0;
      var wd = setTimeout(function() { process.exit(process.exitCode | 0); }, 5000);
      if (wd && typeof wd.unref === 'function') wd.unref();
    }
    process.on('uncaughtException', function(e) {
      if (isExitSignal(e)) return;
      console.log('[CORPUS-RESULT] FAIL uncaught: ' + (e && e.stack || String(e)).split('\\n')[0]);
      deferredExit(1);
    });
    process.on('unhandledRejection', function(r) {
      console.log('[CORPUS-RESULT] FAIL unhandled: ' + (r && r.stack || String(r)).split('\\n')[0]);
      deferredExit(1);
    });
    try {
      require('/test/parallel/${testName}');
      console.log('[CORPUS-RESULT] PASS-PROVISIONAL');
      deferredExit(0);
    } catch (e) {
      if (isExitSignal(e)) {
        var code = (e.code | 0);
        if (code === 0) { console.log('[CORPUS-RESULT] PASS'); process.exit(0); }
        console.log('[CORPUS-RESULT] FAIL exit=' + code);
        process.exit(code);
      }
      console.log('[CORPUS-RESULT] FAIL sync: ' + (e && e.stack || String(e)).split('\\n')[0]);
      console.error((e && e.stack) || String(e));
      deferredExit(1);
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
      // Diagnostic: capture more of what happened
      const tail = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return "no-log-element";
        return log.innerText.split("\n").slice(-30).join("\n");
      }).catch(e => `eval-failed: ${e.message}`);
      return { status: "timeout", logs: consoleLogs.slice(-5).join("\n"), tail };
    }
    // Browser-target's _start sentinel can't propagate process.exit codes
    // reliably -- TerminateExecution unwinds without ExitSignal so we
    // get "(returned)". Instead, our driver emits an explicit
    // [CORPUS-RESULT] PASS / PASS-PROVISIONAL / FAIL marker we grep for.
    //
    // PASS-PROVISIONAL is logged immediately after require() returns,
    // BEFORE the deferred exit runs.  If a deferred event later prints
    // "Mismatched <name> function calls. Expected ..., actual ..." at
    // process exit time (common.mustCall's at-exit verifier), the
    // provisional pass is downgraded to FAIL.  Otherwise it upgrades
    // to PASS.
    const result = await page.evaluate(() => {
      const log = document.getElementById("log");
      if (!log) return { passed: false, line: "no-log" };
      const text = log.innerText;
      const matches = [...text.matchAll(/\[CORPUS-RESULT\] (PASS-PROVISIONAL|PASS|FAIL[^\n]*)/g)];
      if (matches.length === 0) return { passed: false, line: "no-marker" };
      const last = matches[matches.length - 1][1];
      if (last === "PASS") return { passed: true, line: "PASS" };
      if (last.startsWith("FAIL")) return { passed: false, line: last };
      const mustCallMismatch = /Mismatched [^\s]+ function calls\. Expected [^,]+, actual \d+\./.test(text);
      if (mustCallMismatch) {
        return { passed: false, line: "FAIL mustCall mismatch (deferred)" };
      }
      return { passed: true, line: "PASS (provisional confirmed)" };
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
  const manifest = loadKnownFailures();
  // Classify each result against the manifest.
  const classified = results.map((r) => ({ result: r, ...classifyResult(r, manifest) }));
  const states = { PASS: 0, FAIL: 0, "KNOWN-FAIL": 0, "KNOWN-FAIL-CHANGED": 0, "UNEXPECTED-PASS": 0 };
  const knownFailChanged = [];
  const unexpectedPass = [];
  for (const c of classified) {
    states[c.state] = (states[c.state] || 0) + 1;
    if (c.state === "KNOWN-FAIL-CHANGED") {
      knownFailChanged.push({
        test: c.result.test,
        category: c.category,
        expected: c.expected,
        actual: c.actualReason,
      });
    }
    if (c.state === "UNEXPECTED-PASS") {
      unexpectedPass.push({ test: c.result.test, category: c.category });
    }
  }
  const raw = states.PASS + states["UNEXPECTED-PASS"];
  const total = results.length;
  const known = states["KNOWN-FAIL"] + states["KNOWN-FAIL-CHANGED"];
  const adjustedDen = Math.max(0, total - known);
  const summary = {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    totalTests: total,
    pass: raw,
    fail: states.FAIL,
    timeout: results.filter((r) => r.status === "timeout").length,
    knownFail: states["KNOWN-FAIL"],
    knownFailChanged: states["KNOWN-FAIL-CHANGED"],
    unexpectedPass: states["UNEXPECTED-PASS"],
    rawPassRate: total === 0 ? 0 : Math.round((raw / total) * 10000) / 100,
    adjustedPassRate: adjustedDen === 0 ? null : Math.round((raw / adjustedDen) * 10000) / 100,
    perBucket: aggregates.map((a) => ({
      bucket: a.bucket,
      pass: a.pass,
      fail: a.fail,
      timeout: a.timeout,
      total: a.total,
      passRate: a.total === 0 ? 0 : Math.round((a.pass / a.total) * 10000) / 100,
    })),
    knownFailChangedDetail: knownFailChanged,
    unexpectedPassDetail: unexpectedPass,
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
  lines.push(`* Total: ${summary.totalTests} (pass ${summary.pass} / fail ${summary.fail} / known-fail ${summary.knownFail ?? 0} / timeout ${summary.timeout})`);
  lines.push(`* **Raw pass rate**: ${summary.rawPassRate ?? "?"}%`);
  lines.push(`* **Adjusted pass rate** (excluding known-fails): ${summary.adjustedPassRate ?? "?"}%`);
  if (summary.knownFailChanged) {
    lines.push(`* ⚠️ KNOWN-FAIL-CHANGED: ${summary.knownFailChanged} (test failed but signature differs from known-failures.json — see corpus-results.json for details)`);
  }
  if (summary.unexpectedPass) {
    lines.push(`* 🎉 UNEXPECTED-PASS: ${summary.unexpectedPass} (test in known-failures.json now passes — consider removing entry)`);
  }
  lines.push("");
  lines.push("## Per-module pass rates");
  lines.push("");
  lines.push("| Module | Pass | Fail | Timeout | Total | Pass rate |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const b of summary.perBucket) {
    lines.push(`| \`${b.bucket}\` | ${b.pass} | ${b.fail} | ${b.timeout} | ${b.total} | ${b.passRate}% |`);
  }
  lines.push("");
  lines.push("Source: `corpus-results.json` (same dir).  Known-failure manifest: `browser-target/known-failures.json`.");
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
  console.log("\n=== known-failures classification ===");
  console.log(`  raw pass rate:       ${summary.rawPassRate}%  (${summary.pass}/${summary.totalTests})`);
  const adj = summary.adjustedPassRate === null ? "N/A (all tests known-fail)" : `${summary.adjustedPassRate}%`;
  console.log(`  adjusted pass rate:  ${adj}  (excluding ${summary.knownFail ?? 0} known-fails)`);
  if (summary.knownFailChanged) {
    console.log(`  ⚠️  KNOWN-FAIL-CHANGED: ${summary.knownFailChanged}`);
    for (const d of summary.knownFailChangedDetail || []) {
      console.log(`     ${d.test}: expected="${d.expected}" but got="${(d.actual||'').slice(0,80)}"`);
    }
  }
  if (summary.unexpectedPass) {
    console.log(`  🎉 UNEXPECTED-PASS: ${summary.unexpectedPass} (consider removing from known-failures.json)`);
    for (const d of summary.unexpectedPassDetail || []) {
      console.log(`     ${d.test} [${d.category}]`);
    }
  }
  console.log("\n=== per-bucket pass rates ===");
  for (const b of summary.perBucket) {
    console.log(`  ${b.bucket.padEnd(20)} ${b.pass}/${b.total} (${b.passRate}%)`);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 1; });
