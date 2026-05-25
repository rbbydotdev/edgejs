// Shared bootstrap helpers for browser-{test,perf}-runner.mjs.
//
// Both runners need the same Vite spawn, Playwright Chromium launch, and
// the same sentinel regex for "_start finished".  Factoring those out
// keeps the two entry points small and prevents perf-runner drift from
// changing how the test runner observes completion.
//
// Anything that's specifically about "compare expected vs actual stdout"
// stays in browser-test-runner.mjs.  Anything that's about "measure
// timing / extract metrics from the page log" lives in
// browser-perf-runner.mjs.  This file is the boring infra under both.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const browserTarget = resolve(here, "..");
export const projectRoot = resolve(browserTarget, "..");
export const testsDir = resolve(projectRoot, "tests", "js");

export const VITE_PORT = 5173; // vite's default; strictPort below makes us fail fast if taken
export const VITE_READY_TIMEOUT_MS = 30_000;
export const TEST_TIMEOUT_MS = 30_000;

// Worker emits this line at the end of every run.  matched[0] is the
// full text; matched[1] is "exit=<N>" | "THREW" | "returned"; matched[2]
// is the exit code when matched[1] is "exit=...".  Source of truth is
// browser-target/src/worker.ts (`_start ran ${runMs.toFixed(0)} ms ...`).
export const SENTINEL_RE = /_start ran (\d+) ms \((exit=(-?\d+)|THREW|returned)\)/;

// The "about to call _start" marker.  Used by perf runner to compute
// wasm-execution time independent of bootstrap/instantiation time.
// Source of truth is browser-target/src/worker.ts ("emnapi bound; running _start…").
export const PRE_START_MARKER = "emnapi bound; running _start";

// Spawn `npm run dev` (vite) in browser-target and wait until it's
// ready to serve.  Resolves with the ChildProcess; caller is
// responsible for SIGTERMing it at the end.
export async function startVite() {
  // Followup e33 (post-buffer-investigation): bump Node's max HTTP
  // header size from the 16 KB default to 256 KB.  The test harness
  // delivers user scripts via `?script=<encoded>` URL params; complex
  // scripts (template literals, special chars) URL-encode to ~1.4x raw
  // size, so a 7 KB raw test file becomes a ~10 KB URL — close enough
  // to the 16 KB default that headers (incl. cookies, accept-encoding,
  // etc) plus the URL overflowed and got HTTP 431.  Vite-served scripts
  // are a test-harness concern only; production loads scripts via fetch
  // or imports, not URL params, so this doesn't affect runtime limits.
  const proc = spawn(
    "npm",
    ["run", "dev", "--", "--port", String(VITE_PORT), "--strictPort"],
    {
      cwd: browserTarget,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: {
        ...process.env,
        // 256 KB — comfortable margin over any realistic test script.
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-http-header-size=262144`.trim(),
      },
    },
  );
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
      while (!resolved && Date.now() < deadline) await delay(200);
      if (!resolved) rejectReady(new Error("vite ready timeout"));
    })();
  });
  return proc;
}

// Lazy-imports playwright; surfaces a helpful error if the dep or the
// chromium binary isn't installed.  Returns the launched browser.
//
// Chrome 137+ ships JSPI unflagged but Playwright's bundled Chromium
// may lag; the --enable-features flag is harmless on newer builds.
export async function launchChromium() {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (e) {
    throw new Error(
      "playwright not installed in browser-target/node_modules.\n" +
      "  Run: cd browser-target && npm install && npx playwright install chromium\n" +
      `Underlying: ${(e && e.message) || e}`,
    );
  }
  return playwright.chromium.launch({
    headless: true,
    args: [
      "--enable-features=WebAssemblyJavaScriptPromiseIntegration",
      "--js-flags=--experimental-wasm-jspi --experimental-wasm-exnref",
    ],
  });
}

// Best-effort cleanup; used in finally blocks where we don't want
// stray exceptions to mask the real error.
export function killProc(proc) {
  try { proc?.kill("SIGTERM"); } catch { /* best effort */ }
}
