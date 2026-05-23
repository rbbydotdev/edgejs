#!/usr/bin/env node
// Browser-target perf measurement harness (Lever B Layer 0).
//
// Sibling to browser-test-runner.mjs: same Vite + Playwright bootstrap,
// same page-navigation flow, same _start-completion sentinel.  Whereas
// the test runner cares "did stdout match", this runner cares "how
// long did each phase take and how many napi calls did it take to get
// there".
//
// Usage:
//   node browser-target/scripts/browser-perf-runner.mjs <test> [--runs=N]
//
//   <test>     stem of a test file under tests/js/ (e.g. `log` → tests/js/log.js)
//   --runs=N   iterations (default 5).  Each run is a fresh page + context.
//
// What we measure per iteration:
//
//   - totalMs           Node-side wall clock from `page.goto(...)` to
//                       the moment the sentinel appears in the DOM.
//                       Bracket includes Vite request + page bootstrap
//                       + worker spawn + wasm instantiate + _start.
//   - wasmRunMs         The `<N> ms` extracted from the `_start ran <N> ms`
//                       sentinel — worker-measured time for _start itself.
//                       Excludes everything before _start.
//   - totalCalls        Sum of all wasi/napi/etc. import calls during _start.
//                       From the worker's "total calls: <N>" summary line.
//   - namespaceCalls    Per-namespace breakdown.  Keys are the namespaces
//                       the worker reports under "by namespace:", e.g.
//                       `napi`, `wasi_snapshot_preview1`, `wasix_32v1`.
//
// Output:
//
//   - stdout: human-readable min/max/mean/median for each metric across N
//             runs (plus per-run list for spot-checks).
//   - plans/lever-b-progress.md: appends a "## Baseline measurements"
//             section (creating the file if absent) with timestamp +
//             short git rev + JSON entry.  Subsequent runs append more
//             entries; never overwrites prior data.
//
// Failure mode:
//   - 30s timeout per run (matches test runner).  If a run times out
//     we record what we got and continue; the human summary marks the
//     missing runs.
//   - Vite + Chromium are torn down on every exit path.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  projectRoot,
  testsDir,
  VITE_PORT,
  TEST_TIMEOUT_MS,
  SENTINEL_RE,
  startVite,
  launchChromium,
  killProc,
} from "./_runner-common.mjs";

// Match a "by namespace:" body line, e.g.:
//   "  napi                         total= 14179  distinct=46"
// Captures (ns, total).  distinct is collected too but not exposed in
// the summary — kept available for future op-shape audits.
const NS_LINE_RE = /^\s+(\S+)\s+total=\s*(\d+)\s+distinct=\s*(\d+)\s*$/;
// "total calls: 14334"
const TOTAL_LINE_RE = /^total calls:\s*(\d+)\s*$/m;

const PROGRESS_FILE = resolve(projectRoot, "plans", "lever-b-progress.md");

function parseArgs(argv) {
  // argv[0] = test stem, plus optional --runs=N.
  let testStem;
  let runs = 5;
  for (const a of argv) {
    if (a.startsWith("--runs=")) {
      const n = Number(a.slice("--runs=".length));
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`invalid --runs value: ${a}`);
      }
      runs = n;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (!testStem) {
      testStem = a;
    } else {
      throw new Error(`unexpected positional arg: ${a}`);
    }
  }
  if (!testStem) throw new Error("missing <test> arg (e.g. `log` for tests/js/log.js)");
  return { testStem, runs };
}

function gitRev() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "(unknown)";
  }
}

function loadTest(testStem) {
  const jsPath = resolve(testsDir, `${testStem}.js`);
  if (!existsSync(jsPath)) {
    throw new Error(`test not found: ${jsPath}`);
  }
  return { jsPath, script: readFileSync(jsPath, "utf8") };
}

// Pull the entire `#log` innerText after sentinel observed.  Worker emits
// the trace summary as a single `post("log", ...)` whose text starts
// with "\ntotal calls: ...", so it lands as one .lvl-info span — but
// innerText flattens everything, which is what we want for parsing.
async function scrapeLog(page) {
  return page.evaluate(() => {
    const log = document.getElementById("log");
    return log ? log.innerText || "" : "";
  });
}

function extractMetrics(logText, sentinelMatch) {
  // sentinelMatch is the result of SENTINEL_RE.exec on logText.
  // Group 1 = wasm runMs, group 2 = full status token, group 3 = exit code.
  const wasmRunMs = sentinelMatch ? Number(sentinelMatch[1]) : null;
  const exitToken = sentinelMatch?.[2] ?? null;
  const exitCode = sentinelMatch?.[3] != null ? Number(sentinelMatch[3]) : null;

  const totalMatch = logText.match(TOTAL_LINE_RE);
  const totalCalls = totalMatch ? Number(totalMatch[1]) : null;

  // Find the "by namespace:" block and scan subsequent lines until the
  // next non-namespace line.  Lines have the leading-space + symbol
  // shape captured by NS_LINE_RE.
  const namespaceCalls = {};
  const lines = logText.split("\n");
  const startIdx = lines.findIndex((l) => /^by namespace:\s*$/.test(l));
  if (startIdx >= 0) {
    for (let i = startIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(NS_LINE_RE);
      if (!m) break; // first non-ns line ends the block
      namespaceCalls[m[1]] = Number(m[2]);
    }
  }

  return { wasmRunMs, exitToken, exitCode, totalCalls, namespaceCalls };
}

async function runOnce(browser, script) {
  const url = `http://localhost:${VITE_PORT}/?script=${encodeURIComponent(script)}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  // Console mirror for diagnostics on failure.  Not used in success path.
  const consoleLogs = [];
  page.on("console", (msg) => consoleLogs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${err.message}`));

  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    const deadline = Date.now() + TEST_TIMEOUT_MS;
    let sentinelMatch = null;
    while (Date.now() < deadline) {
      // Pull the raw innerText; sentinel regex is matched Node-side so
      // we don't have to round-trip the regex source through page.evaluate.
      const text = await scrapeLog(page);
      const m = text.match(SENTINEL_RE);
      if (m) { sentinelMatch = m; break; }
      await delay(50); // 50ms is fine; cheaper than 100ms for short runs
    }
    const totalMs = Date.now() - t0;

    if (!sentinelMatch) {
      return {
        ok: false,
        reason: `timeout: no _start sentinel within ${TEST_TIMEOUT_MS}ms`,
        totalMs,
        logs: consoleLogs.slice(-20).join("\n"),
      };
    }

    const logText = await scrapeLog(page);
    const metrics = extractMetrics(logText, sentinelMatch);

    if (metrics.exitToken === "THREW") {
      return {
        ok: false,
        reason: "wasm threw",
        totalMs,
        ...metrics,
        logs: consoleLogs.slice(-20).join("\n"),
      };
    }
    if (metrics.exitCode !== null && metrics.exitCode !== 0) {
      return {
        ok: false,
        reason: `non-zero exit (${metrics.exitCode})`,
        totalMs,
        ...metrics,
        logs: consoleLogs.slice(-20).join("\n"),
      };
    }

    return { ok: true, totalMs, ...metrics };
  } finally {
    await context.close();
  }
}

// Stats helpers — operate on number[] (may be empty if all runs failed).
function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median,
    n: sorted.length,
  };
}

function fmt(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(digits);
}

function summarize(testStem, runs, results) {
  const oks = results.filter((r) => r.ok);
  const lines = [];
  lines.push(`browser-perf-runner: ${testStem}  runs=${runs}  ok=${oks.length}/${runs}`);

  // Per-run table for spot-checking.
  lines.push("");
  lines.push("per-run:");
  lines.push(`  ${"#".padStart(3)}  ${"total ms".padStart(9)}  ${"wasm ms".padStart(8)}  ${"calls".padStart(7)}  status`);
  results.forEach((r, i) => {
    if (r.ok) {
      lines.push(`  ${String(i + 1).padStart(3)}  ${fmt(r.totalMs, 0).padStart(9)}  ${fmt(r.wasmRunMs, 0).padStart(8)}  ${String(r.totalCalls ?? "—").padStart(7)}  ok`);
    } else {
      lines.push(`  ${String(i + 1).padStart(3)}  ${fmt(r.totalMs, 0).padStart(9)}  ${"—".padStart(8)}  ${"—".padStart(7)}  FAIL: ${r.reason}`);
    }
  });

  if (oks.length === 0) {
    lines.push("");
    lines.push("no successful runs; nothing to aggregate.");
    return { text: lines.join("\n"), aggregated: null };
  }

  const totalMsStats = stats(oks.map((r) => r.totalMs));
  const wasmMsStats = stats(oks.map((r) => r.wasmRunMs).filter((v) => v !== null));
  const totalCallsStats = stats(oks.map((r) => r.totalCalls).filter((v) => v !== null));

  // Per-namespace aggregation: union of keys across runs.
  const nsKeys = new Set();
  for (const r of oks) for (const k of Object.keys(r.namespaceCalls ?? {})) nsKeys.add(k);
  const nsStats = {};
  for (const ns of nsKeys) {
    nsStats[ns] = stats(
      oks
        .map((r) => r.namespaceCalls?.[ns])
        .filter((v) => v !== undefined && v !== null),
    );
  }

  lines.push("");
  lines.push("aggregated (across successful runs):");
  const header = `  ${"metric".padEnd(34)}  ${"min".padStart(8)}  ${"max".padStart(8)}  ${"mean".padStart(8)}  ${"median".padStart(8)}`;
  lines.push(header);
  const row = (name, s, digits = 1) => `  ${name.padEnd(34)}  ${fmt(s?.min, digits).padStart(8)}  ${fmt(s?.max, digits).padStart(8)}  ${fmt(s?.mean, digits).padStart(8)}  ${fmt(s?.median, digits).padStart(8)}`;
  lines.push(row("totalMs (nav → sentinel)", totalMsStats, 0));
  lines.push(row("wasmRunMs (_start exec)", wasmMsStats, 0));
  lines.push(row("totalCalls (all imports)", totalCallsStats, 0));
  for (const ns of [...nsKeys].sort()) {
    lines.push(row(`  ${ns}`, nsStats[ns], 0));
  }

  const aggregated = {
    totalMs: totalMsStats,
    wasmRunMs: wasmMsStats,
    totalCalls: totalCallsStats,
    namespaceCalls: nsStats,
    okRuns: oks.length,
    totalRuns: runs,
  };
  return { text: lines.join("\n"), aggregated };
}

// Append an entry to plans/lever-b-progress.md.  File is created with a
// header if it doesn't exist; subsequent runs only append.  Each entry
// is a fenced JSON block under a stable "## Baseline measurements"
// section heading.  We don't try to be clever about merging — just
// append; the file is for humans to scroll through.
function writeProgress(entry) {
  const plansDir = resolve(projectRoot, "plans");
  mkdirSync(plansDir, { recursive: true });

  const fresh = !existsSync(PROGRESS_FILE);
  if (fresh) {
    const preamble =
      "# Lever B — Progress log\n" +
      "\n" +
      "Per-layer progress entries appended by tooling and humans.  Each\n" +
      "perf-runner invocation appends a baseline-measurement JSON block\n" +
      "under the section below.  See `plans/lever-b.md` for the plan.\n" +
      "\n" +
      "## Baseline measurements\n" +
      "\n";
    appendFileSync(PROGRESS_FILE, preamble);
  }

  const block =
    `### ${entry.timestamp}  test=${entry.test}  rev=${entry.gitRev}  runs=${entry.runs}\n` +
    "\n" +
    "```json\n" +
    JSON.stringify(entry, null, 2) + "\n" +
    "```\n" +
    "\n";
  appendFileSync(PROGRESS_FILE, block);
}

async function main() {
  let testStem, runs;
  try {
    ({ testStem, runs } = parseArgs(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.stderr.write(`usage: node browser-perf-runner.mjs <test-stem> [--runs=N]\n`);
    process.exit(2);
  }

  let test;
  try {
    test = loadTest(testStem);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }

  process.stdout.write(`browser-perf-runner: test=${testStem} runs=${runs}\n`);
  process.stdout.write(`  test path: ${test.jsPath}\n`);

  let viteProc;
  try {
    viteProc = await startVite();
  } catch (e) {
    process.stderr.write(`vite startup failed: ${(e && e.message) || e}\n`);
    process.exit(2);
  }

  let browser;
  try {
    browser = await launchChromium();
  } catch (e) {
    process.stderr.write(`error: ${(e && e.message) || e}\n`);
    killProc(viteProc);
    process.exit(2);
  }

  const results = [];
  try {
    for (let i = 0; i < runs; i++) {
      process.stdout.write(`  run ${i + 1}/${runs}…\n`);
      try {
        const r = await runOnce(browser, test.script);
        results.push(r);
        if (!r.ok) {
          process.stdout.write(`    FAIL: ${r.reason}\n`);
        } else {
          process.stdout.write(`    ok  totalMs=${r.totalMs} wasmRunMs=${r.wasmRunMs} totalCalls=${r.totalCalls}\n`);
        }
      } catch (e) {
        results.push({ ok: false, reason: `exception: ${e?.message ?? e}` });
        process.stdout.write(`    FAIL: ${e?.message ?? e}\n`);
      }
    }
  } finally {
    try { await browser.close(); } catch { /* best effort */ }
    killProc(viteProc);
  }

  const { text, aggregated } = summarize(testStem, runs, results);
  process.stdout.write("\n" + text + "\n");

  if (aggregated) {
    const entry = {
      timestamp: new Date().toISOString(),
      test: testStem,
      gitRev: gitRev(),
      runs,
      aggregated,
      perRun: results.map((r) => ({
        ok: r.ok,
        reason: r.reason ?? null,
        totalMs: r.totalMs ?? null,
        wasmRunMs: r.wasmRunMs ?? null,
        totalCalls: r.totalCalls ?? null,
        namespaceCalls: r.namespaceCalls ?? null,
      })),
    };
    try {
      writeProgress(entry);
      process.stdout.write(`\nwrote entry to ${PROGRESS_FILE}\n`);
    } catch (e) {
      process.stderr.write(`warning: failed to append to progress file: ${e?.message ?? e}\n`);
    }
  }

  const allFailed = results.every((r) => !r.ok);
  process.exit(allFailed ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(2);
});
