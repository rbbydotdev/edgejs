#!/usr/bin/env node
// Regression net over tests/js/*.js — runs each test through node-harness in
// --quiet mode and compares captured stdout/stderr to sibling .stdout/.stderr
// expectation files.  Exit 0 on all-pass, 1 on any failure or runner error.
//
// Conventions (per-test, all siblings of the .js file):
//   foo.js              — the test program (mandatory)
//   foo.stdout          — expected fd-1 output (default: empty)
//   foo.stderr          — expected fd-2 output (default: empty)
//   foo.skip            — file presence skips the test; body is the reason
//   foo.harness-args    — extra args passed to node-harness (e.g. --override)
//
// Why spawn-per-test: edge.wasm has long-lived internal state that we can't
// cheaply reset between runs.  One harness process per test gives clean
// isolation at ~250-300ms each — fine for a small corpus.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const browserTarget = resolve(here, "..");
const projectRoot = resolve(browserTarget, "..");
const testsDir = resolve(projectRoot, "tests", "js");
const harnessPath = resolve(here, "node-harness.mjs");
const tsxLoader = resolve(browserTarget, "node_modules", "tsx", "dist", "loader.mjs");

if (!existsSync(testsDir)) {
  process.stderr.write(`error: tests dir not found: ${testsDir}\n`);
  process.exit(2);
}

function read(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function collectTests() {
  return readdirSync(testsDir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => {
      const stem = f.slice(0, -3);
      const jsPath = resolve(testsDir, f);
      return {
        stem,
        jsPath,
        skipPath: resolve(testsDir, `${stem}.skip`),
        stdoutPath: resolve(testsDir, `${stem}.stdout`),
        stderrPath: resolve(testsDir, `${stem}.stderr`),
        harnessArgsPath: resolve(testsDir, `${stem}.harness-args`),
      };
    });
}

function runOne(t) {
  if (existsSync(t.skipPath)) {
    return { status: "skip", reason: read(t.skipPath).trim() || "(no reason)" };
  }
  const script = readFileSync(t.jsPath, "utf8");
  const extra = existsSync(t.harnessArgsPath)
    ? read(t.harnessArgsPath).trim().split(/\s+/).filter(Boolean)
    : [];
  const args = [
    "--experimental-wasm-exnref",
    "--import", tsxLoader,
    harnessPath,
    "--quiet",
    ...extra,
    "-e", script,
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: browserTarget,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.error) return { status: "error", reason: String(res.error) };
  if (res.status !== 0) {
    return {
      status: "error",
      reason: `harness exit ${res.status}\nstderr:\n${res.stderr.slice(-2000)}`,
    };
  }

  const expectedOut = existsSync(t.stdoutPath) ? read(t.stdoutPath) : "";
  const expectedErr = existsSync(t.stderrPath) ? read(t.stderrPath) : "";
  const actualOut = res.stdout;
  const actualErr = res.stderr;

  const outOk = actualOut === expectedOut;
  const errOk = actualErr === expectedErr;
  if (outOk && errOk) return { status: "pass" };
  return {
    status: "fail",
    diff: [
      outOk ? null : `stdout differs:\n  expected: ${JSON.stringify(expectedOut)}\n  actual:   ${JSON.stringify(actualOut)}`,
      errOk ? null : `stderr differs:\n  expected: ${JSON.stringify(expectedErr)}\n  actual:   ${JSON.stringify(actualErr)}`,
    ].filter(Boolean).join("\n"),
  };
}

const tests = collectTests();
if (tests.length === 0) {
  process.stderr.write(`no tests found in ${testsDir}\n`);
  process.exit(2);
}

let pass = 0, fail = 0, skip = 0, error = 0;
const failures = [];

for (const t of tests) {
  const t0 = Date.now();
  const r = runOne(t);
  const ms = Date.now() - t0;
  const tag = r.status.toUpperCase().padEnd(5);
  const detail = r.status === "skip" ? ` — ${r.reason}` : "";
  process.stdout.write(`${tag} ${basename(t.jsPath)} (${ms}ms)${detail}\n`);
  if (r.status === "pass") pass++;
  else if (r.status === "skip") skip++;
  else if (r.status === "fail") { fail++; failures.push({ name: basename(t.jsPath), diff: r.diff }); }
  else { error++; failures.push({ name: basename(t.jsPath), diff: r.reason }); }
}

process.stdout.write(`\n${pass} pass, ${fail} fail, ${error} error, ${skip} skip\n`);
for (const f of failures) {
  process.stdout.write(`\n--- ${f.name} ---\n${f.diff}\n`);
}
process.exit(fail + error === 0 ? 0 : 1);
