// E38 — poll_oneoff sub trace.  Patch wasi-shim.ts to log every
// poll_oneoff call's branch decision.  Also patch worker.ts to inject
// the e37-style keepalive (uv_async_init + uv_ref, no other handles).
// Run with empty user script.
//
// Goal: pinpoint which decision in pollOneoffAsyncImpl is causing
// _start to return without blocking on our pipe-read sub.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const shimPath = resolve(repoRoot, "browser-target", "src", "wasi-shim.ts");
const workerPath = resolve(repoRoot, "browser-target", "src", "worker.ts");

const SHIM_MARK = "/* e38 shim trace */";
const WORKER_MARK = "// e38 worker keepalive";

function patch() {
  // wasi-shim.ts: add tracing inside pollOneoffAsyncImpl
  const shim = readFileSync(shimPath, "utf8");
  if (shim.includes(SHIM_MARK)) throw new Error("shim already patched");

  // Insert log at the top of pollOneoffAsyncImpl (right after the
  // depth-holder JSPI check) — capture call counter + key inputs.
  const anchor1 = `function pollOneoffAsyncImpl(`;
  if (!shim.includes(anchor1)) throw new Error("pollOneoffAsyncImpl anchor not found");

  // Insert AFTER pollOneoffWalkSubs call but BEFORE branches — capture
  // walked state.  Use the exact existing line as the anchor.
  const anchor2 = `if (nWritten > 0 || nsubs === 0) {`;
  const anchor3 = `if (minTimeoutNs >= 0 && !hasSocketSub) {`;
  const anchor4 = `// Any sub kind not immediately ready: race the wake sources.`;

  // Also patch pollOneoffSyncImpl entry
  const anchor5 = `function pollOneoffSyncImpl(`;

  // Insert at after the JSPI re-entry check returns sync impl
  const anchor6 = `return pollOneoffSyncImpl(inPtr, outPtr, nsubs, neventsPtr);`;

  let patched = shim
    .replace(
      anchor6,
      `${anchor6.replace(';', '')};\n      ${SHIM_MARK}\n      try { (globalThis as { __e38N?: number }).__e38N = ((globalThis as { __e38N?: number }).__e38N ?? 0) + 1; ctx.postLog(\`[e38][async-call#\` + ((globalThis as { __e38N?: number }).__e38N) + \`] → SYNC (depth<=0)\`, "info"); } catch (e) { void e; }`,
    )
    .replace(
      anchor2,
      `${SHIM_MARK}\n    try {
      (globalThis as { __e38N?: number }).__e38N = ((globalThis as { __e38N?: number }).__e38N ?? 0) + 1;
      const e38n = (globalThis as { __e38N?: number }).__e38N;
      ctx.postLog(\`[e38][async-call#\` + e38n + \`] nsubs=\` + nsubs + \` minTimeoutNs=\` + minTimeoutNs + \` hasSocketSub=\` + hasSocketSub + \` pipeReadSubs=\` + r.pipeReadSubs.length + \` nWritten=\` + nWritten, "info");
    } catch (e) { void e; }
    ${anchor2}`,
    )
    .replace(
      anchor3,
      `${SHIM_MARK}\n    try { ctx.postLog(\`[e38][async-call#\` + ((globalThis as { __e38N?: number }).__e38N) + \`] → about to take TIMER-ONLY branch (minTimeoutNs=\` + minTimeoutNs + \`, hasSocketSub=\` + hasSocketSub + \`, pipeReadSubs=\` + r.pipeReadSubs.length + \`)\`, "info"); } catch (e) { void e; }
    ${anchor3}`,
    )
    .replace(
      anchor4,
      `${SHIM_MARK}\n    try { ctx.postLog(\`[e38][async-call#\` + ((globalThis as { __e38N?: number }).__e38N) + \`] → falling through to RACE branch (pipeReadSubs=\` + r.pipeReadSubs.length + \`)\`, "info"); } catch (e) { void e; }
    ${anchor4}`,
    );
  writeFileSync(shimPath, patched, "utf8");

  // worker.ts: add keepalive (same as e37)
  const worker = readFileSync(workerPath, "utf8");
  if (worker.includes(WORKER_MARK)) throw new Error("worker already patched");
  const wAnchor = `post("log", { text: "emnapi bound; running _start…", level: "info" });`;
  const wBlock = `
  ${WORKER_MARK}
  try {
    const exp = instance.exports as Record<string, unknown>;
    const uvDefaultLoop = exp["uv_default_loop"] as undefined | (() => number);
    const uvAsyncInit = exp["uv_async_init"] as undefined | ((l: number, h: number, cb: number) => number);
    const uvRef = exp["uv_ref"] as undefined | ((h: number) => void);
    const uvHandleSize = exp["uv_handle_size"] as undefined | ((t: number) => number);
    const guestMalloc = exp["unofficial_napi_guest_malloc"] as undefined | ((n: number) => number);
    const mem = (exp["memory"] || (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory) as WebAssembly.Memory | undefined;
    if (uvDefaultLoop && uvAsyncInit && uvRef && uvHandleSize && guestMalloc && mem) {
      const loop = uvDefaultLoop();
      const size = uvHandleSize(1);
      const h = guestMalloc(size);
      new Uint8Array(mem.buffer, h, size).fill(0);
      uvAsyncInit(loop, h, 0);
      uvRef(h);
      post("log", { text: "[e38-keepalive] engaged", level: "info" });
    }
  } catch (e) { post("log", { text: "[e38-keepalive] threw: " + (e as Error).message, level: "warn" }); }
`;
  writeFileSync(workerPath, worker.replace(wAnchor, `${wAnchor}\n${wBlock}`), "utf8");
}

function revert(originals) {
  writeFileSync(shimPath, originals.shim, "utf8");
  writeFileSync(workerPath, originals.worker, "utf8");
}

const TEST_SCRIPT = `
console.log('[e38-user] bootstrap-done t=' + Math.round(performance.now()));
`;

async function run() {
  const originals = {
    shim: readFileSync(shimPath, "utf8"),
    worker: readFileSync(workerPath, "utf8"),
  };
  let viteProc = null;
  let browser = null;
  try {
    patch();
    viteProc = await startVite();
    browser = await launchChromium();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (/\[e38\]|\[e38-keepalive\]|\[e38-user\]|_start ran/.test(t)) console.log(t);
    });
    page.on("pageerror", (err) => console.log("! pageerror:", err.message));
    await page.goto(`http://localhost:${VITE_PORT}/?script=${encodeURIComponent(TEST_SCRIPT)}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const SENTINEL = /_start ran \d+ ms/;
    const deadline = Date.now() + 25_000;
    let lastLog = "";
    while (Date.now() < deadline) {
      lastLog = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? log.innerText : "";
      });
      if (SENTINEL.test(lastLog)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const lines = lastLog.split("\n").filter(l => /\[e38\]|\[e38-keepalive\]|\[e38-user\]|_start ran/.test(l));
    console.log("\n=== E38 TRACE (full) ===");
    for (const l of lines) console.log(l);
    console.log("=== END E38 ===\n");
    // Summary
    const branchCounts = { sync: 0, immReady: 0, timerOnly: 0, race: 0 };
    for (const l of lines) {
      if (l.includes("→ SYNC")) branchCounts.sync++;
      if (l.includes("nsubs=0")) branchCounts.immReady++;
      if (l.includes("→ about to take TIMER-ONLY")) branchCounts.timerOnly++;
      if (l.includes("→ falling through to RACE")) branchCounts.race++;
    }
    console.log("Branch summary:", branchCounts);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
    revert(originals);
  }
}

run().catch((e) => { console.error("[e38] FATAL:", e); process.exitCode = 1; });
