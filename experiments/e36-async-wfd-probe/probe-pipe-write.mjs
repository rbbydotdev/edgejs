// E36-pipe-write — instrument the wasi-shim's pipeRegistry.write
// in-place with a console.log, run the same scenario as e35-TEST-C,
// and observe whether uv_async_send's write actually reaches
// pipeRegistry.write.
//
// If we see "[ws-pipe-write]" lines after uv_async_send: the chain
// works up to that point; the bug must be in poll_oneoff's wake-set
// (race-of-waiters didn't include the async pipe).
//
// If we DON'T see them: the write is going through a different path
// (not pipeRegistry) — likely wasi-libc routes write() differently
// for low-numbered libuv-allocated fds.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const pipesSabPath = resolve(repoRoot, "browser-target", "src", "wasi-shim", "pipes-sab.ts");
const workerPath = resolve(repoRoot, "browser-target", "src", "worker.ts");

const PIPES_MARKER = "/* e36-pipe-write instrumentation */";
const WORKER_MARKER = "// e36-pipe-write worker probe";

function patch() {
  // 1. Instrument pipeRegistry.write
  const pipesSrc = readFileSync(pipesSabPath, "utf8");
  if (pipesSrc.includes(PIPES_MARKER)) throw new Error("pipes-sab already patched");
  const pipesAnchor = "write(slot: number, src: Uint8Array): number {";
  if (!pipesSrc.includes(pipesAnchor)) throw new Error("write() anchor not found in pipes-sab.ts");
  const pipesPatched = pipesSrc.replace(
    pipesAnchor,
    `${pipesAnchor}\n    ${PIPES_MARKER}\n    try { console.log("[ws-pipe-write] slot=" + slot + " len=" + src.length + " t=" + Math.round(performance.now())); } catch (e) { void e; }`,
  );
  writeFileSync(pipesSabPath, pipesPatched, "utf8");

  // 2. In worker.ts, immediately after bindInstance, install an
  //    uv_async handle + schedule uv_async_send at +500ms while
  //    the user script runs a 1000ms timer.
  const workerSrc = readFileSync(workerPath, "utf8");
  if (workerSrc.includes(WORKER_MARKER)) throw new Error("worker.ts already patched");
  const bindAnchor = `post("log", { text: "emnapi bound; running _start…", level: "info" });`;
  const block = `
  ${WORKER_MARKER}
  try {
    const exp = instance.exports as Record<string, unknown>;
    const uvDefaultLoop = exp["uv_default_loop"] as undefined | (() => number);
    const uvAsyncInit = exp["uv_async_init"] as undefined | ((l: number, h: number, cb: number) => number);
    const uvAsyncSend = exp["uv_async_send"] as undefined | ((h: number) => number);
    const uvHandleSize = exp["uv_handle_size"] as undefined | ((t: number) => number);
    const uvRef = exp["uv_ref"] as undefined | ((h: number) => void);
    const guestMalloc = exp["unofficial_napi_guest_malloc"] as undefined | ((n: number) => number);
    const mem = (exp["memory"] || (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory) as WebAssembly.Memory | undefined;
    if (uvDefaultLoop && uvAsyncInit && uvAsyncSend && uvHandleSize && uvRef && guestMalloc && mem) {
      const loop = uvDefaultLoop();
      const size = uvHandleSize(1);
      const h = guestMalloc(size);
      new Uint8Array(mem.buffer, h, size).fill(0);
      const initRc = uvAsyncInit(loop, h, 0);
      uvRef(h);
      post("log", { text: \`[e36-pw] handle init rc=\${initRc} h=\${h}; will send at t=500\`, level: "info" });
      setTimeout(() => {
        const tSend = Math.round(performance.now());
        const sendRc = uvAsyncSend(h);
        post("log", { text: \`[e36-pw] uv_async_send rc=\${sendRc} at t=\${tSend}\`, level: "info" });
      }, 500);
    }
  } catch (e) {
    post("log", { text: \`[e36-pw] threw: \${(e as Error).message}\`, level: "warn" });
  }
`;
  const workerPatched = workerSrc.replace(bindAnchor, `${bindAnchor}\n${block}`);
  writeFileSync(workerPath, workerPatched, "utf8");
}

function revert(originals) {
  writeFileSync(pipesSabPath, originals.pipes, "utf8");
  writeFileSync(workerPath, originals.worker, "utf8");
}

const TEST_SCRIPT = `
console.log('[e36-pw-user] bootstrap');
setTimeout(() => {
  console.log('[e36-pw-user] timer fired');
  process.exit(0);
}, 1000);
`;

async function run() {
  const originals = {
    pipes: readFileSync(pipesSabPath, "utf8"),
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
      if (/\[e36-pw\]|\[e36-pw-user\]|\[ws-pipe-write\]|_start ran/.test(t)) console.log("  >", t);
    });
    page.on("pageerror", (err) => console.log("  ! pageerror:", err.message));
    await page.goto(`http://localhost:${VITE_PORT}/?script=${encodeURIComponent(TEST_SCRIPT)}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const SENTINEL = /_start ran \d+ ms/;
    const deadline = Date.now() + 20_000;
    let lastLog = "";
    while (Date.now() < deadline) {
      lastLog = await page.evaluate(() => {
        const log = document.getElementById("log");
        return log ? log.innerText : "";
      });
      if (SENTINEL.test(lastLog)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    console.log("\n=== E36-PIPE-WRITE OUTPUT ===");
    for (const l of lastLog.split("\n").filter(l => /\[e36-pw\]|\[e36-pw-user\]|\[ws-pipe-write\]/.test(l))) console.log(l);
    const sentinel = lastLog.match(/_start ran[^\n]+/);
    console.log("[e36-pw] sentinel:", sentinel ? sentinel[0] : "(not seen)");
    console.log("=== END E36-PIPE-WRITE ===\n");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
    revert(originals);
  }
}

run().catch((e) => { console.error("[e36-pw] FATAL:", e); process.exitCode = 1; });
