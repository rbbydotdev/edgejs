#!/usr/bin/env node
// Scaled corpus driver: runs the corpus runner across a curated list of
// (filter, limit) pairs in a single Vite + Chromium session, then merges
// the JSON outputs into one summary.  Intended as the "compromise"
// between a 5-test smoke and an overnight 3961-test full run.
//
// Each (filter, limit) is one chunk; chunks share the Vite/browser
// instance to avoid the ~5s startup cost per chunk.  Output paths are
// per-chunk plus one merged summary.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const outDir = resolve(repoRoot, "corpus");

// Chunks: balance coverage vs runtime.  Aim for ~15 minutes total —
// alphabetical sort within each filter, so we get the early-in-alphabet
// slice of each category.  Bigger LIMIT on small modules (full coverage),
// smaller LIMIT on large modules (sample).
const CHUNKS = [
  { filter: "test-event-", limit: 28 },           // all 28
  { filter: "test-events-", limit: 999 },         // all (handful)
  { filter: "test-assert-", limit: 19 },          // all 19
  { filter: "test-url-", limit: 17 },             // all 17
  { filter: "test-path-", limit: 17 },            // all 17
  { filter: "test-util-", limit: 27 },            // all 27
  { filter: "test-os-", limit: 8 },               // all 8
  { filter: "test-string-decoder-", limit: 3 },   // all 3
  { filter: "test-querystring-", limit: 4 },      // all 4
  { filter: "test-buffer-", limit: 20 },          // sample
  { filter: "test-stream-", limit: 20 },          // sample
  { filter: "test-zlib-", limit: 15 },            // sample
  { filter: "test-timers-", limit: 15 },          // sample
  { filter: "test-fs-", limit: 15 },              // sample
  { filter: "test-crypto-", limit: 15 },          // sample
  { filter: "test-http-", limit: 15 },            // sample
  { filter: "test-vm-", limit: 15 },              // sample
  { filter: "test-process-", limit: 15 },         // sample
  { filter: "test-worker-", limit: 15 },          // sample
  { filter: "test-child-process-", limit: 10 },   // sample
  { filter: "test-async-hooks-", limit: 10 },     // sample
  { filter: "test-perf-hooks-", limit: 10 },      // sample
];

mkdirSync(outDir, { recursive: true });

async function runChunk(chunk, idx) {
  const chunkOut = resolve(outDir, "chunks", `${idx.toString().padStart(2, "0")}-${chunk.filter.replace(/[^a-z0-9]/gi, "_")}`);
  mkdirSync(chunkOut, { recursive: true });
  console.log(`\n=== chunk ${idx + 1}/${CHUNKS.length}: ${chunk.filter} (limit ${chunk.limit}) ===`);
  await new Promise((resolveDone, rejectDone) => {
    const proc = spawn(
      "node",
      [resolve(here, "node-corpus-runner.mjs"), chunk.filter, `--out=${chunkOut}`],
      { cwd: resolve(here, ".."), stdio: "inherit", env: { ...process.env, LIMIT: String(chunk.limit) } },
    );
    proc.once("error", rejectDone);
    proc.once("exit", (code) => {
      // Runner itself exits 0 even if some tests fail; treat any exit code
      // < 2 as completion (let the JSON tell the real story).
      if (code === null || code > 1) rejectDone(new Error(`chunk ${chunk.filter} exited code=${code}`));
      else resolveDone();
    });
  });
  const jsonPath = resolve(chunkOut, "corpus-results.json");
  if (!existsSync(jsonPath)) throw new Error(`chunk ${chunk.filter} produced no json at ${jsonPath}`);
  return JSON.parse(readFileSync(jsonPath, "utf8"));
}

function mergeSummaries(summaries) {
  const allResults = summaries.flatMap((s) => s.results);
  const startedAt = Math.min(...summaries.map((s) => s.startedAt));
  const finishedAt = Math.max(...summaries.map((s) => s.finishedAt));
  // Re-bucket via the runner's own bucket logic — duplicated here for
  // independence; matches node-corpus-runner.mjs:bucketFor.
  const buckets = new Map();
  for (const r of allResults) {
    const b = bucketForTest(r.test);
    let agg = buckets.get(b);
    if (!agg) { agg = { bucket: b, pass: 0, fail: 0, timeout: 0, total: 0 }; buckets.set(b, agg); }
    agg.total++;
    if (r.status === "pass") agg.pass++;
    else if (r.status === "timeout") agg.timeout++;
    else agg.fail++;
  }
  return {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    chunksRun: summaries.length,
    totalTests: allResults.length,
    pass: allResults.filter((r) => r.status === "pass").length,
    fail: allResults.filter((r) => r.status === "fail" || r.status === "err").length,
    timeout: allResults.filter((r) => r.status === "timeout").length,
    perBucket: [...buckets.values()]
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
      .map((a) => ({
        bucket: a.bucket,
        pass: a.pass,
        fail: a.fail,
        timeout: a.timeout,
        total: a.total,
        passRate: a.total === 0 ? 0 : Math.round((a.pass / a.total) * 10000) / 100,
      })),
    results: allResults,
  };
}

function bucketForTest(name) {
  const body = name.replace(/^test-/, "").replace(/\.(js|mjs|cjs)$/, "");
  const multi = [
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
  for (const [p, b] of multi) if (body.startsWith(p)) return b;
  if (body.startsWith("event-") || body.startsWith("events-") || body === "events") return "events";
  if (body.startsWith("worker-")) return "worker_threads";
  const m = /^([a-z][a-z0-9]*)(?:-|$)/.exec(body);
  return m ? m[1] : "_misc";
}

function writeMd(mdPath, merged) {
  const lines = [];
  lines.push("# Node Test Corpus Pass Rates (edgejs-web) — Scaled Run");
  lines.push("");
  lines.push("Auto-generated by `browser-target/scripts/node-corpus-scaled.mjs`.");
  lines.push("");
  lines.push(`* Started:  ${new Date(merged.startedAt).toISOString()}`);
  lines.push(`* Finished: ${new Date(merged.finishedAt).toISOString()}`);
  lines.push(`* Duration: ${(merged.durationMs / 1000 / 60).toFixed(1)} min`);
  lines.push(`* Chunks:   ${merged.chunksRun}`);
  const rate = merged.totalTests === 0 ? 0 : Math.round((merged.pass / merged.totalTests) * 10000) / 100;
  lines.push(`* Total:    ${merged.totalTests} (pass ${merged.pass} / fail ${merged.fail} / timeout ${merged.timeout})`);
  lines.push(`* Overall pass rate: **${rate}%**`);
  lines.push("");
  lines.push("This run samples each category rather than running the full");
  lines.push("3961-test corpus; the per-module pass rates are directional,");
  lines.push("not an exhaustive measurement.  See `corpus-results.json` for");
  lines.push("the per-test outcomes used to derive these numbers.");
  lines.push("");
  lines.push("## Per-module pass rates");
  lines.push("");
  lines.push("| Module | Pass | Fail | Timeout | Total | Pass rate |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const b of merged.perBucket) {
    lines.push(`| \`${b.bucket}\` | ${b.pass} | ${b.fail} | ${b.timeout} | ${b.total} | ${b.passRate}% |`);
  }
  lines.push("");
  writeFileSync(mdPath, lines.join("\n") + "\n");
}

async function main() {
  const startedAt = Date.now();
  const summaries = [];
  for (let i = 0; i < CHUNKS.length; i++) {
    try { summaries.push(await runChunk(CHUNKS[i], i)); }
    catch (e) {
      console.error(`chunk ${CHUNKS[i].filter} failed: ${e.message}`);
    }
  }
  if (summaries.length === 0) { console.error("no chunks produced results"); process.exit(1); }
  const merged = mergeSummaries(summaries);
  writeFileSync(resolve(outDir, "corpus-results.json"), JSON.stringify(merged, null, 2) + "\n");
  writeMd(resolve(outDir, "corpus-summary.md"), merged);
  console.log("\n=== overall ===");
  console.log(`  ${merged.pass}/${merged.totalTests} pass (${Math.round((merged.pass / merged.totalTests) * 100)}%)`);
  console.log(`  wrote ${outDir}/corpus-results.json + corpus-summary.md`);
  console.log("\n=== per-bucket ===");
  for (const b of merged.perBucket) {
    console.log(`  ${b.bucket.padEnd(22)} ${b.pass}/${b.total} (${b.passRate}%)`);
  }
  const elapsedMin = (Date.now() - startedAt) / 1000 / 60;
  console.log(`\n  elapsed: ${elapsedMin.toFixed(1)} min`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
