#!/usr/bin/env node
// Browser-target regression net.  This is the runner that actually exercises
// the deployment shape — wasm in a DedicatedWorker, JSPI yields, SAB-backed
// bridge/pipe rings, COOP/COEP-isolated context.
//
// Pipeline per test:
//
//   1. Read tests/js/<stem>.js + sibling .stdout (expected) and .skip.
//   2. Spawn Vite dev (once per run) — serves browser-target with the
//      COOP/COEP headers the wasm needs to instantiate against SAB.
//   3. Launch Playwright Chromium, navigate to
//      `http://localhost:<port>/?script=<encoded-test-source>`.
//      Browser-target's main.ts already honors `?script=<URL-encoded>`
//      and routes it through edge as `edgejs -e <source>`.
//   4. Wait for the worker's completion sentinel — a log line matching
//      `/^_start ran \d+ ms \((exit=\d+|THREW|returned)\)/`.
//      Times out at 30s per test.
//   5. Scrape all `.lvl-out` spans, strip the `[stdout] ` prefix the
//      worker prepends, join with newlines. Compare to expected.
//
// Pass = output matches AND exit was 0.
//
// Sibling-file conventions match the existing node-harness runner so test
// authors don't have to learn a new layout:
//   foo.js              — test (mandatory)
//   foo.stdout          — expected stdout (default: empty)
//   foo.skip            — presence skips; body is the reason
//   foo.harness-args    — currently IGNORED in browser runner (TODO: map
//                          to URL params if/when policies need per-test
//                          opt-in via the browser harness).  #!~debt
//                          browser-runner-ignores-harness-args
//
// Why this exists separately from node-harness: node-harness runs the
// same wasi-shim/napi-host code but against Node's V8, not the browser's
// V8 in a DedicatedWorker.  Only the browser runner catches Lever-B-class
// breakage where the wasm thread is the worker thread, microtasks queue
// on the worker's V8, and JSPI suspends the worker stack.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const browserTarget = resolve(here, "..");
const projectRoot = resolve(browserTarget, "..");
const testsDir = resolve(projectRoot, "tests", "js");

const TEST_TIMEOUT_MS = 30_000;
const VITE_READY_TIMEOUT_MS = 30_000;
const VITE_PORT = 5173; // vite's default; runner asserts and aborts if taken.

// Lazy-import Playwright so the file at least parses without the dep
// installed.  Real `test:browser` runs do require it.
let playwright;

function read(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function collectTests(filter) {
  return readdirSync(testsDir)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => !filter || f.includes(filter))
    .sort()
    .map((f) => {
      const stem = f.slice(0, -3);
      return {
        stem,
        jsPath: resolve(testsDir, f),
        stdoutPath: resolve(testsDir, `${stem}.stdout`),
        skipPath: resolve(testsDir, `${stem}.skip`),
      };
    });
}

// Spawn `npm run dev` (vite) and wait until it answers on $VITE_PORT.
async function startVite() {
  const proc = spawn("npm", ["run", "dev", "--", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: browserTarget,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  let resolved = false;
  const deadline = Date.now() + VITE_READY_TIMEOUT_MS;
  await new Promise((resolveReady, rejectReady) => {
    const onData = (buf) => {
      const s = buf.toString("utf8");
      if (!resolved && /ready in|Local:.*:\d+/.test(s)) {
        resolved = true;
        resolveReady();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("error", rejectReady);
    proc.once("exit", (code) => {
      if (!resolved) rejectReady(new Error(`vite exited before ready (code=${code})`));
    });
    (async () => {
      while (!resolved && Date.now() < deadline) {
        await delay(200);
      }
      if (!resolved) rejectReady(new Error("vite ready timeout"));
    })();
  });
  return proc;
}

const SENTINEL_RE = /_start ran \d+ ms \((exit=(-?\d+)|THREW|returned)\)/;

async function runOne(browser, t) {
  if (existsSync(t.skipPath)) {
    return { status: "skip", reason: read(t.skipPath).trim() || "(no reason)" };
  }
  const script = readFileSync(t.jsPath, "utf8");
  const expectedOut = existsSync(t.stdoutPath) ? read(t.stdoutPath) : "";
  const url = `http://localhost:${VITE_PORT}/?script=${encodeURIComponent(script)}`;

  const context = await browser.newContext();
  const page = await context.newPage();

  let sentinel = null;
  const consoleLogs = [];

  // Mirror page console for diagnostics on failure.  We don't compare
  // against this — actual user stdout lives in DOM .lvl-out spans —
  // but it's useful when a test fails to know what the worker logged.
  page.on("console", (msg) => consoleLogs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${err.message}`));

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    // Poll DOM for the sentinel.  Cheap because we're scraping innerText
    // of a known element; no extra page injection needed.
    const deadline = Date.now() + TEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      sentinel = await page.evaluate((re) => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = log.innerText.match(new RegExp(re));
        return m ? { matched: m[0], exit: m[1] === "THREW" || m[1] === "returned" ? null : Number(m[2]) } : null;
      }, SENTINEL_RE.source);
      if (sentinel) break;
      await delay(100);
    }

    if (!sentinel) {
      return {
        status: "error",
        reason: `timeout: no _start completion sentinel within ${TEST_TIMEOUT_MS}ms`,
        logs: consoleLogs.slice(-20).join("\n"),
      };
    }

    // Scrape user stdout from .lvl-out spans that come AFTER the
    // "── edgejs.wasm" section marker.  The worker runs a hello.wasm
    // smoke first which also produces .lvl-out output; we only care
    // about edge's stdout.
    const actualOut = await page.evaluate(() => {
      const log = document.getElementById("log");
      if (!log) return "";
      const children = Array.from(log.children);
      // Find the start of the edge section.  Marker text is set in
      // worker.ts (`runEdgeWithEmnapi`): "── edgejs.wasm (emnapi + WASI host) ──"
      let startIdx = 0;
      for (let i = 0; i < children.length; i++) {
        const t = children[i].textContent ?? "";
        if (t.includes("── edgejs.wasm")) { startIdx = i + 1; break; }
      }
      const lines = [];
      for (let i = startIdx; i < children.length; i++) {
        const el = children[i];
        if (!el.classList?.contains("lvl-out")) continue;
        let text = el.textContent ?? "";
        // worker.ts prepends "[stdout] " to user output lines.
        if (text.startsWith("[stdout] ")) text = text.slice(9);
        // append() trails each entry with a newline; strip exactly
        // one so join("\n") matches the node-harness convention.
        if (text.endsWith("\n")) text = text.slice(0, -1);
        // The worker's own completion summary is emitted at level
        // "out" when exit=0; not user stdout.
        if (/^✓ end-to-end success/.test(text)) continue;
        lines.push(text);
      }
      return lines.join("\n") + (lines.length > 0 ? "\n" : "");
    });

    if (sentinel.exit !== 0 && sentinel.exit !== null) {
      return {
        status: "fail",
        reason: `non-zero exit (${sentinel.exit})`,
        expected: expectedOut,
        actual: actualOut,
        logs: consoleLogs.slice(-20).join("\n"),
      };
    }
    if (sentinel.exit === null && sentinel.matched.includes("THREW")) {
      return {
        status: "fail",
        reason: "wasm threw before exit",
        expected: expectedOut,
        actual: actualOut,
        logs: consoleLogs.slice(-20).join("\n"),
      };
    }

    if (actualOut !== expectedOut) {
      // On failure, scrape the entire #log DOM for diagnostic.  The
      // poll-probe / clock-probe / [worker] lines explain the wasm
      // event-loop state when the test diverged.
      const fullLog = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? (log.innerText || "") : "";
      });
      return {
        status: "fail",
        reason: "stdout mismatch",
        expected: expectedOut,
        actual: actualOut,
        logs: consoleLogs.slice(-20).join("\n"),
        fullLog,
      };
    }
    return { status: "pass" };
  } finally {
    await context.close();
  }
}

async function main() {
  const filter = process.argv[2]; // optional substring filter
  const tests = collectTests(filter);
  if (tests.length === 0) {
    process.stderr.write(`no tests found${filter ? ` matching "${filter}"` : ""}\n`);
    process.exit(2);
  }

  try {
    playwright = await import("playwright");
  } catch (e) {
    process.stderr.write(
      "error: 'playwright' not installed in browser-target/node_modules.\n" +
      "  Run: cd browser-target && npm install && npx playwright install chromium\n" +
      `Underlying: ${(e && e.message) || e}\n`,
    );
    process.exit(2);
  }

  process.stdout.write(`browser-test-runner: ${tests.length} test(s)\n`);

  // Vite first — fail fast if cross-origin isolation can't come up.
  let viteProc;
  try {
    viteProc = await startVite();
  } catch (e) {
    process.stderr.write(`vite startup failed: ${(e && e.message) || e}\n`);
    process.exit(2);
  }

  // Chromium with JSPI enabled.  Chrome 137+ ships JSPI unflagged
  // (https://v8.dev/blog/jspi-ot) but Playwright's bundled Chromium
  // may lag; the --enable-features flag is harmless on newer builds.
  let browser;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        "--enable-features=WebAssemblyJavaScriptPromiseIntegration",
        "--js-flags=--experimental-wasm-jspi --experimental-wasm-exnref",
      ],
    });
  } catch (e) {
    process.stderr.write(
      "error: failed to launch Chromium.\n" +
      `  Did you run \`npx playwright install chromium\` from browser-target?\n` +
      `Underlying: ${(e && e.message) || e}\n`,
    );
    try { viteProc.kill("SIGTERM"); } catch { /* best effort */ }
    process.exit(2);
  }

  let pass = 0, fail = 0, skip = 0, err = 0;
  const failures = [];
  try {
    for (const t of tests) {
      const result = await runOne(browser, t);
      const tag = ({
        pass: "ok",
        fail: "FAIL",
        skip: "skip",
        error: "ERR",
      })[result.status] ?? "?";
      process.stdout.write(`  ${tag}  ${t.stem}\n`);
      if (result.status === "pass") pass++;
      else if (result.status === "skip") { skip++; if (result.reason) process.stdout.write(`        reason: ${result.reason.split("\n")[0]}\n`); }
      else if (result.status === "fail") { fail++; failures.push({ stem: t.stem, ...result }); }
      else if (result.status === "error") { err++; failures.push({ stem: t.stem, ...result }); }
    }
  } finally {
    await browser.close();
    try { viteProc.kill("SIGTERM"); } catch { /* best effort */ }
  }

  process.stdout.write(`\n${pass} pass, ${fail} fail, ${err} err, ${skip} skip\n`);

  if (failures.length > 0) {
    process.stdout.write("\nFailures:\n");
    for (const f of failures) {
      process.stdout.write(`\n--- ${f.stem} (${f.status}: ${f.reason}) ---\n`);
      if (f.expected !== undefined) {
        process.stdout.write(`expected:\n${f.expected}---\nactual:\n${f.actual}---\n`);
      }
      if (f.logs) process.stdout.write(`console logs (tail):\n${f.logs}\n`);
      if (f.fullLog) process.stdout.write(`page #log content:\n${f.fullLog}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(2);
});
