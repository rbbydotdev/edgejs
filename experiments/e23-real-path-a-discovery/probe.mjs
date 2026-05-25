// E23 — Real Path A: callback funcref probe.
//
// E23 already confirmed uv_async_init / uv_async_send are callable from
// host JS during _start's JSPI suspension.  This probe answers Q4:
// "which funcref do we pass as `cb`?"
//
// Strategy: pass cb=0 (NULL).  libuv's uv__io_poll has an explicit
// `if (h->async_cb == NULL) continue;` guard at
// deps/libuv-wasix/src/unix/async.c:205-206, so a NULL cb is the
// documented "skip dispatch" sentinel.  This means we never need a
// real funcref — the wake-up itself is what matters (the message
// payload flows through the existing reverse-RPC funcref dispatch at
// browser-target/src/host-worker/callback-dispatch.ts:320-360, which
// the wasm microtask checkpoint drains after uv_run yields).
//
// What the probe verifies:
//   1. uv_async_init(loop, handle, /*cb=*/0) returns 0.
//   2. uv_async_send(handle) returns 0.
//   3. _start runs uv_run, sees pending=1 on our handle, hits the
//      NULL-cb skip path, and continues without trapping.
//   4. _start exits cleanly (exit=0).
//
// If (3) traps, the NULL-cb hypothesis is wrong — and we fall back to
// growing the table by 1 with a JS-defined WebAssembly.Function of
// signature `(externref) -> ()` ... but that's much more invasive,
// so we want to confirm NULL works first.
//
// The probe also tests an EARLY-fire scenario where uv_async_send is
// called BEFORE _start enters uv_run.  pending=1 is latched on the
// handle pre-poll; uv__io_poll dispatches it on the first iteration.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workerPath = resolve(repoRoot, "browser-target", "src", "worker.ts");

const PROBE_MARKER = "// e23-cb probe insertion";

// Inserted right after `napi.bindInstance(...)` / "emnapi bound" log.
// At this point _start has NOT yet been invoked; the libuv default
// loop has been initialized by __wasm_call_ctors and the loop's own
// internal async (wq_async) is live, but our handle is brand-new.
//
// We pass cb=0 and uv_async_send the handle.  _start will then begin,
// enter uv_run, and process the pending async during uv__io_poll.
// The NULL-cb guard should fire and we continue cleanly.
const PROBE_BLOCK_AFTER_BIND = `
  ${PROBE_MARKER} after-bind
  try {
    const exp = instance.exports as Record<string, unknown>;
    const uvDefaultLoop = exp["uv_default_loop"] as undefined | (() => number);
    const uvHandleSize = exp["uv_handle_size"] as undefined | ((t: number) => number);
    const uvAsyncInit = exp["uv_async_init"] as undefined | ((l: number, h: number, cb: number) => number);
    const uvAsyncSend = exp["uv_async_send"] as undefined | ((h: number) => number);
    const guestMalloc = exp["unofficial_napi_guest_malloc"] as undefined | ((n: number) => number);
    const mem = (exp["memory"] || (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory) as WebAssembly.Memory | undefined;
    if (!uvDefaultLoop || !uvHandleSize || !uvAsyncInit || !uvAsyncSend || !guestMalloc || !mem) {
      post("log", { text: \`[e23-cb] missing exports: uvDefaultLoop=\${typeof uvDefaultLoop} init=\${typeof uvAsyncInit} send=\${typeof uvAsyncSend} malloc=\${typeof guestMalloc} mem=\${mem?'yes':'no'}\`, level: "warn" });
    } else {
      // === TEST: cb = 0 (NULL).  libuv's async.c:205 skips dispatch
      // when async_cb is NULL.  Verifies _start can drain pending
      // async with no cb invocation.
      const loop = uvDefaultLoop();
      const size = uvHandleSize(1); // UV_ASYNC
      const handle = guestMalloc(size);
      new Uint8Array(mem.buffer, handle, size).fill(0);
      const initRc = uvAsyncInit(loop, handle, 0);
      post("log", { text: \`[e23-cb] (pre-start) uv_async_init(loop=\${loop}, handle=\${handle}, cb=0) rc=\${initRc}\`, level: "info" });
      const sendRc = uvAsyncSend(handle);
      post("log", { text: \`[e23-cb] (pre-start) uv_async_send(handle) rc=\${sendRc}\`, level: "info" });
      // Stash for verification after _start finishes.
      (globalThis as { __e23cbHandle?: number; __e23cbExports?: unknown }).__e23cbHandle = handle;
      (globalThis as { __e23cbExports?: unknown }).__e23cbExports = { uvAsyncSend, uvAsyncInit, uvHandleSize, uvDefaultLoop, guestMalloc };
      (globalThis as { __e23cbMemory?: WebAssembly.Memory }).__e23cbMemory = mem;
      // === Secondary: schedule a delayed uv_async_send during _start's
      // JSPI-suspended window.  Tests the more realistic "wake-up
      // message arrives mid-flight" scenario.  We allocate a SECOND
      // handle so we can distinguish pre-start vs during-start.
      setTimeout(() => {
        try {
          const ex = (globalThis as { __e23cbExports?: { uvAsyncInit: (l: number, h: number, cb: number) => number; uvAsyncSend: (h: number) => number; uvHandleSize: (t: number) => number; uvDefaultLoop: () => number; guestMalloc: (n: number) => number } }).__e23cbExports;
          const m = (globalThis as { __e23cbMemory?: WebAssembly.Memory }).__e23cbMemory;
          if (!ex || !m) {
            post("log", { text: "[e23-cb] (during-start) missing exports/memory", level: "warn" });
            return;
          }
          const sz2 = ex.uvHandleSize(1);
          const h2 = ex.guestMalloc(sz2);
          new Uint8Array(m.buffer, h2, sz2).fill(0);
          const rc2 = ex.uvAsyncInit(ex.uvDefaultLoop(), h2, 0);
          const sd2 = ex.uvAsyncSend(h2);
          post("log", { text: \`[e23-cb] (during-start) cb=0 init rc=\${rc2} send rc=\${sd2} handle=\${h2}\`, level: "info" });
        } catch (e) {
          post("log", { text: \`[e23-cb] (during-start) threw \${(e as Error).message}\`, level: "warn" });
        }
      }, 80);
    }
  } catch (probeErr) {
    post("log", { text: \`[e23-cb] probe-after-bind threw: \${(probeErr as Error).message}\`, level: "warn" });
  }
`;

function patchWorker() {
  const src = readFileSync(workerPath, "utf8");
  if (src.includes(PROBE_MARKER)) {
    throw new Error("worker.ts already has e23-cb probe markers — refusing to patch twice");
  }
  const bindAnchor = `post("log", { text: "emnapi bound; running _start…", level: "info" });`;
  if (!src.includes(bindAnchor)) {
    throw new Error("could not find bindInstance anchor in worker.ts");
  }
  const patched = src.replace(bindAnchor, `${bindAnchor}\n${PROBE_BLOCK_AFTER_BIND}`);
  writeFileSync(workerPath, patched, "utf8");
}

function revertWorker(original) {
  writeFileSync(workerPath, original, "utf8");
}

// Test script: chain a couple of timers so _start stays alive long
// enough for the during-start setTimeout(80ms) to fire and for uv_run
// to make multiple iterations.
const PROBE_TEST_SCRIPT = `
process.nextTick(() => { console.log('e23-cb: nextTick'); });
setTimeout(() => {
  console.log('e23-cb: t1');
  setTimeout(() => { console.log('e23-cb: t2'); process.exit(0); }, 200);
}, 150);
`;

async function runProbe() {
  console.log("[e23-cb] reading worker.ts…");
  const original = readFileSync(workerPath, "utf8");

  let viteProc = null;
  let browser = null;
  try {
    console.log("[e23-cb] patching worker.ts…");
    patchWorker();
    console.log("[e23-cb] starting vite…");
    viteProc = await startVite();
    console.log("[e23-cb] launching chromium…");
    browser = await launchChromium();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (/\[e23-cb\]|_start ran|e23-cb:/.test(t)) {
        console.log("  >", t);
      }
    });
    page.on("pageerror", (err) => {
      console.log("  ! pageerror:", err.message);
    });
    const enc = encodeURIComponent(PROBE_TEST_SCRIPT);
    const url = "http://localhost:" + VITE_PORT + "/?script=" + enc;
    console.log("[e23-cb] navigating…");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

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
    const probeLines = lastLog.split("\n").filter(l => l.includes("[e23-cb]"));
    console.log("\n=== E23-CB PROBE OUTPUT ===");
    for (const l of probeLines) console.log(l);
    const sentinel = lastLog.match(/_start ran[^\n]+/);
    console.log("[e23-cb] sentinel:", sentinel ? sentinel[0] : "(not seen — wasm may have hung)");
    console.log("=== END E23-CB PROBE ===\n");
    if (!probeLines.length) {
      console.log("[e23-cb] (no probe lines; first 2KB of log):");
      console.log(lastLog.slice(0, 2000));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
    console.log("[e23-cb] reverting worker.ts…");
    revertWorker(original);
  }
}

runProbe().catch((e) => {
  console.error("[e23-cb] FATAL:", e);
  process.exitCode = 1;
});
