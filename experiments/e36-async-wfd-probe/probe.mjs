// E36 — Probe the actual fd values libuv's async pipe uses, to
// determine if uv_async_send's write goes through wasi-shim's
// pipeRegistry (5000+ range) or falls through to nowhere (low fd).
//
// E35 confirmed uv_async_send returns 0 but doesn't wake poll_oneoff.
// Two competing hypotheses:
//   (a) async fds land in pipeRegistry range, but pipeRegistry.write
//       isn't bumping the wakeCounter correctly (some chain break).
//   (b) async fds DON'T land in pipeRegistry range — they go to some
//       other path that writes successfully but doesn't notify poll.
//
// This probe reads loop->async_wfd directly from wasm memory at the
// known offset (352 bytes from loop start, per the libuv-wasix
// UV_LOOP_PRIVATE_FIELDS layout) and logs the actual fd value.
//
// Decision:
//   - fd in [5000, 5128) → hypothesis (a); investigate pipeRegistry
//     bookkeeping or poll_oneoff race-of-waiters
//   - fd outside that range → hypothesis (b); libuv used a different
//     primitive (regular POSIX pipe?) that bypasses pipeRegistry.
//     Fix: route those writes through pipeRegistry, OR have wasi-shim
//     allocate the async pipe via fd_pipe explicitly.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workerPath = resolve(repoRoot, "browser-target", "src", "worker.ts");

const PROBE_MARKER = "// e36 probe insertion";

// Offsets inside uv_loop_t per libuv-wasix uv/unix.h UV_LOOP_PRIVATE_FIELDS:
//   async_io_watcher: uv__io_t at offset 296 (.fd at +48 → 344)
//   async_wfd:        int at offset 352
// These are the agent-derived offsets — probe will sanity-check them
// by reading multiple offsets and looking for plausible fd values
// (small positive ints).
const PROBE_BLOCK = `
  ${PROBE_MARKER}
  try {
    const exp = instance.exports as Record<string, unknown>;
    const uvDefaultLoop = exp["uv_default_loop"] as undefined | (() => number);
    const uvAsyncInit = exp["uv_async_init"] as undefined | ((l: number, h: number, cb: number) => number);
    const uvAsyncSend = exp["uv_async_send"] as undefined | ((h: number) => number);
    const uvHandleSize = exp["uv_handle_size"] as undefined | ((t: number) => number);
    const guestMalloc = exp["unofficial_napi_guest_malloc"] as undefined | ((n: number) => number);
    const mem = (exp["memory"] || (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory) as WebAssembly.Memory | undefined;

    if (!uvDefaultLoop || !uvAsyncInit || !uvAsyncSend || !uvHandleSize || !guestMalloc || !mem) {
      post("log", { text: \`[e36] missing exports — abort\`, level: "warn" });
    } else {
      const loop = uvDefaultLoop();
      const dv = new DataView(mem.buffer);

      // 1) Init our own async handle (forces uv__async_start which sets
      //    loop->async_wfd if not already set).  uv_loop_init also
      //    init's wq_async at startup, which should have set wfd
      //    already — so we may see the wfd populated even before this.
      const size = uvHandleSize(1);
      const h = guestMalloc(size);
      new Uint8Array(mem.buffer, h, size).fill(0);
      const initRc = uvAsyncInit(loop, h, 0);

      // 2) Dump candidate offsets in uv_loop_t to find the wfd.
      //    We sweep offsets 320-400 looking for plausible fd values.
      //    Per the layout analysis: async_io_watcher.fd at 344, async_wfd at 352.
      post("log", { text: \`[e36] loop=\${loop} init_rc=\${initRc} our_handle=\${h}\`, level: "info" });
      const sweep = [];
      for (let off = 256; off <= 400; off += 4) {
        const val = dv.getInt32(loop + off, true);
        if (val > 0 && val < 100000) sweep.push(\`+\${off}=\${val}\`);
      }
      post("log", { text: \`[e36] loop_t plausible-fd sweep: \${sweep.join(" ")}\`, level: "info" });

      // 3) Now do a write-and-detect test.  We don't have a separate
      //    way to read pipeRegistry from here, but we CAN test:
      //    after uv_async_send, the per-pipe wakeCounter (offset 16
      //    into the pipe slot's SAB header) should bump.  Without
      //    direct registry access we'll defer this to a follow-up.
      //    For now, just log: after send, what fd values changed?
      const beforeSend = [];
      for (let off = 320; off <= 380; off += 4) beforeSend.push(dv.getInt32(loop + off, true));
      const sendRc = uvAsyncSend(h);
      const afterSend = [];
      for (let off = 320; off <= 380; off += 4) afterSend.push(dv.getInt32(loop + off, true));
      const diffs = [];
      for (let i = 0; i < beforeSend.length; i++) {
        if (beforeSend[i] !== afterSend[i]) diffs.push(\`+\${320 + i*4}: \${beforeSend[i]} → \${afterSend[i]}\`);
      }
      post("log", { text: \`[e36] uv_async_send rc=\${sendRc} struct-diffs: [\${diffs.join(", ")}]\`, level: "info" });
    }
  } catch (probeErr) {
    post("log", { text: \`[e36] probe threw: \${(probeErr as Error).message}\`, level: "warn" });
  }
`;

function patchWorker() {
  const src = readFileSync(workerPath, "utf8");
  if (src.includes(PROBE_MARKER)) {
    throw new Error("worker.ts already has e36 probe markers — refusing to patch twice");
  }
  const bindAnchor = `post("log", { text: "emnapi bound; running _start…", level: "info" });`;
  if (!src.includes(bindAnchor)) {
    throw new Error("could not find bindInstance anchor in worker.ts");
  }
  const patched = src.replace(bindAnchor, `${bindAnchor}\n${PROBE_BLOCK}`);
  writeFileSync(workerPath, patched, "utf8");
}

function revertWorker(original) {
  writeFileSync(workerPath, original, "utf8");
}

const PROBE_TEST_SCRIPT = `
console.log('[e36-user] bootstrap');
setTimeout(() => process.exit(0), 500);
`;

async function runProbe() {
  const original = readFileSync(workerPath, "utf8");
  let viteProc = null;
  let browser = null;
  try {
    patchWorker();
    viteProc = await startVite();
    browser = await launchChromium();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (/\[e36\]|\[e36-user\]|_start ran/.test(t)) console.log("  >", t);
    });
    page.on("pageerror", (err) => console.log("  ! pageerror:", err.message));
    const enc = encodeURIComponent(PROBE_TEST_SCRIPT);
    await page.goto(`http://localhost:${VITE_PORT}/?script=${enc}`, { waitUntil: "domcontentloaded", timeout: 15_000 });

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
    console.log("\n=== E36 PROBE OUTPUT ===");
    for (const l of lastLog.split("\n").filter(l => /\[e36\]|\[e36-user\]/.test(l))) console.log(l);
    const sentinel = lastLog.match(/_start ran[^\n]+/);
    console.log("[e36] sentinel:", sentinel ? sentinel[0] : "(not seen)");
    console.log("=== END E36 PROBE ===\n");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
    revertWorker(original);
  }
}

runProbe().catch((e) => { console.error("[e36] FATAL:", e); process.exitCode = 1; });
