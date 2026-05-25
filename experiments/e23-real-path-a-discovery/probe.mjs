// E23 — Real Path A discovery probe.
//
// Strategy: monkey-patch `browser-target/src/worker.ts` with a probe
// block that runs after `bindInstance(...)` (before `_start`) AND
// once after `_start` has progressed past `unofficial_napi_create_env`
// (piggybacks on the existing `tryInstallTsfnDispatch` site, which is
// invoked from `dispatchOnLibuvTick` once the env exists).
//
// The probe captures:
//   - uv_default_loop() pointer (before _start vs during _start)
//   - uv_handle_size(UV_ASYNC=1)  (UV_ASYNC is first non-zero entry)
//   - guestMalloc allocates a uv_async_t slot
//   - host-side call to uv_async_send on that handle after _start runs
//     (verifies JSPI re-entry safety)
//   - funcref index 0 lookup (to see if a null-trampoline exists)
//
// Logs are scraped via the playwright runner.  After the probe, the
// worker.ts edits are reverted.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, launchChromium, killProc, VITE_PORT } from "../../browser-target/scripts/_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workerPath = resolve(repoRoot, "browser-target", "src", "worker.ts");

const PROBE_MARKER = "// e23 uv-probe insertion";
const PROBE_BLOCK_AFTER_BIND = `
  ${PROBE_MARKER} after-bind
  try {
    const exp = instance.exports as Record<string, unknown>;
    const uvDefaultLoop = exp["uv_default_loop"] as undefined | (() => number);
    const uvHandleSize = exp["uv_handle_size"] as undefined | ((t: number) => number);
    const uvAsyncInit = exp["uv_async_init"] as undefined | ((l: number, h: number, cb: number) => number);
    const uvAsyncSend = exp["uv_async_send"] as undefined | ((h: number) => number);
    const itab = exp["__indirect_function_table"] as WebAssembly.Table | undefined;
    const guestMalloc = exp["unofficial_napi_guest_malloc"] as undefined | ((n: number) => number);
    post("log", { text: \`[e23] exports: uv_default_loop=\${typeof uvDefaultLoop} uv_handle_size=\${typeof uvHandleSize} uv_async_init=\${typeof uvAsyncInit} uv_async_send=\${typeof uvAsyncSend} itab=\${itab?'yes':'no'} guestMalloc=\${typeof guestMalloc}\`, level: "info" });
    if (uvHandleSize) {
      const sizeAsync = uvHandleSize(1); // UV_ASYNC = 1
      post("log", { text: \`[e23] uv_handle_size(UV_ASYNC=1)=\${sizeAsync}\`, level: "info" });
      const sizeUnknown = uvHandleSize(0); // UV_UNKNOWN_HANDLE
      const sizeTimer  = uvHandleSize(13); // UV_TIMER (sanity reference)
      post("log", { text: \`[e23] uv_handle_size(UNKNOWN=0)=\${sizeUnknown} uv_handle_size(TIMER=13)=\${sizeTimer}\`, level: "info" });
    }
    if (uvDefaultLoop) {
      const loopBefore = uvDefaultLoop();
      post("log", { text: \`[e23] uv_default_loop() BEFORE _start = \${loopBefore}\`, level: "info" });
      (globalThis as { __e23LoopBefore?: number }).__e23LoopBefore = loopBefore;
    }
    if (itab) {
      const len = itab.length;
      post("log", { text: \`[e23] indirect_function_table length=\${len}\`, level: "info" });
      try {
        const slot0 = itab.get(0);
        post("log", { text: \`[e23] itab.get(0) type=\${typeof slot0}\`, level: "info" });
      } catch (e) {
        post("log", { text: \`[e23] itab.get(0) threw: \${(e as Error).message}\`, level: "info" });
      }
      // Sweep a small range to find any plausible no-op callback funcrefs
      // that we could pass to uv_async_init as cb.
      let firstFunc = -1;
      let firstNonNull = -1;
      for (let i = 0; i < Math.min(len, 200); i++) {
        try {
          const f = itab.get(i);
          if (f && firstNonNull === -1) firstNonNull = i;
          if (typeof f === "function" && firstFunc === -1) { firstFunc = i; break; }
        } catch { /* ignore */ }
      }
      post("log", { text: \`[e23] itab firstFunction-in-200=\${firstFunc} firstNonNull-in-200=\${firstNonNull}\`, level: "info" });
    }
    // Try uv_async_init+send PRE-_start (no JSPI activation needed; the
    // loop has been created during static init / __wasm_call_ctors).
    if (uvDefaultLoop && uvHandleSize && uvAsyncInit && uvAsyncSend && guestMalloc) {
      const loopPtr = uvDefaultLoop();
      const size = uvHandleSize(1);
      const handlePtr = guestMalloc(size);
      post("log", { text: \`[e23] pre-start: guestMalloc(\${size})=\${handlePtr}\`, level: "info" });
      // Zero handle slot.
      try {
        const mem = (instance.exports as { memory: WebAssembly.Memory }).memory;
        if (mem && handlePtr) {
          new Uint8Array(mem.buffer, handlePtr, size).fill(0);
        }
      } catch (e) {
        post("log", { text: \`[e23] pre-start: mem zero threw: \${(e as Error).message}\`, level: "warn" });
      }
      // Test 1: cb = funcref index 1 (something callable; signature might
      // not match, but uv_async_init only stores the pointer — doesn't
      // call it.  Call only happens when uv__io_poll picks the pipe.)
      try {
        const rc = uvAsyncInit(loopPtr, handlePtr, 1);
        post("log", { text: \`[e23] pre-start: uv_async_init(loop, handle, cb=1) rc=\${rc}\`, level: "info" });
      } catch (e) {
        post("log", { text: \`[e23] pre-start: uv_async_init(cb=1) threw: \${(e as Error).message}\`, level: "warn" });
      }
      try {
        const sendRc = uvAsyncSend(handlePtr);
        post("log", { text: \`[e23] pre-start: uv_async_send(handle) rc=\${sendRc}\`, level: "info" });
      } catch (e) {
        post("log", { text: \`[e23] pre-start: uv_async_send threw: \${(e as Error).message}\`, level: "warn" });
      }
      // Stash for later use in after-tsfn block.
      (globalThis as { __e23Handle?: number }).__e23Handle = handlePtr;
    }
    (globalThis as { __e23Exports?: unknown }).__e23Exports = { uvDefaultLoop, uvHandleSize, uvAsyncInit, uvAsyncSend, itab, guestMalloc };
    // Schedule a delayed call to uv_async_send from host JS while _start
    // is suspended.  This tests JSPI re-entry safety from host JS into
    // a wasm export that doesn't itself suspend.  We re-init a fresh
    // handle so any pre-start init state is independent.
    // Stash memory reference for cross-scope access from setTimeout
    // below.  Memory is the *imported* shared memory in this build, so we
    // grab it from the napi host's recorded ref (set during bindInstance).
    (globalThis as { __e23Memory?: WebAssembly.Memory }).__e23Memory = (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory;
    setTimeout(() => {
      try {
        const ex = (globalThis as { __e23Exports?: { uvDefaultLoop?: () => number; uvHandleSize?: (t: number) => number; uvAsyncInit?: (l: number, h: number, cb: number) => number; uvAsyncSend?: (h: number) => number; guestMalloc?: (n: number) => number } }).__e23Exports;
        const mem2 = (globalThis as { __e23Memory?: WebAssembly.Memory }).__e23Memory;
        if (!ex || !ex.uvDefaultLoop || !ex.uvHandleSize || !ex.uvAsyncInit || !ex.uvAsyncSend || !ex.guestMalloc || !mem2) {
          post("log", { text: "[e23] during-start: missing exports/memory", level: "warn" });
          return;
        }
        const loopPtr2 = ex.uvDefaultLoop();
        const loopBefore = (globalThis as { __e23LoopBefore?: number }).__e23LoopBefore;
        post("log", { text: \`[e23] during-start: uv_default_loop()=\${loopPtr2} matches BEFORE? \${loopPtr2 === loopBefore}\`, level: "info" });
        const size2 = ex.uvHandleSize(1);
        const handle2 = ex.guestMalloc(size2);
        new Uint8Array(mem2.buffer, handle2, size2).fill(0);
        const initRc = ex.uvAsyncInit(loopPtr2, handle2, 1);
        post("log", { text: \`[e23] during-start: uv_async_init rc=\${initRc} (handle=\${handle2})\`, level: "info" });
        const sendRc = ex.uvAsyncSend(handle2);
        post("log", { text: \`[e23] during-start: uv_async_send rc=\${sendRc} -- HOST CALLED WASM EXPORT WHILE _start SUSPENDED, no trap\`, level: "info" });
      } catch (e) {
        post("log", { text: \`[e23] during-start: threw \${(e as Error).message}\`, level: "warn" });
      }
    }, 150);
  } catch (probeErr) {
    post("log", { text: \`[e23] probe-after-bind threw: \${(probeErr as Error).message}\`, level: "warn" });
  }
`;

const PROBE_BLOCK_AFTER_TSFN = `
  ${PROBE_MARKER} after-tsfn
  try {
    const ex = (globalThis as { __e23Exports?: { uvDefaultLoop?: () => number; uvHandleSize?: (t: number) => number; uvAsyncInit?: (l: number, h: number, cb: number) => number; uvAsyncSend?: (h: number) => number; guestMalloc?: (n: number) => number; itab?: WebAssembly.Table } }).__e23Exports;
    if (!ex) {
      post("log", { text: \`[e23] after-tsfn: no __e23Exports\`, level: "warn" });
    } else {
      const loopDuring = ex.uvDefaultLoop?.();
      const loopBefore = (globalThis as { __e23LoopBefore?: number }).__e23LoopBefore;
      post("log", { text: \`[e23] uv_default_loop() DURING _start = \${loopDuring}; matches BEFORE? \${loopDuring === loopBefore}\`, level: "info" });

      const size = ex.uvHandleSize?.(1) ?? 0;
      const handlePtr = ex.guestMalloc?.(size) ?? 0;
      post("log", { text: \`[e23] guestMalloc(\${size}) -> \${handlePtr}\`, level: "info" });
      // Zero the region.
      try {
        const mem = (globalThis as { __edgeNapiHost?: { wasmMemory: WebAssembly.Memory } }).__edgeNapiHost?.wasmMemory;
        if (mem && handlePtr) {
          const u8 = new Uint8Array(mem.buffer, handlePtr, size);
          u8.fill(0);
        }
      } catch { /* ignore */ }

      // Try uv_async_init with cb=0 (null funcref) — likely fails, but
      // see what happens.  In libuv the cb may legitimately be NULL.
      try {
        const rc = ex.uvAsyncInit?.(loopDuring ?? 0, handlePtr, 0);
        post("log", { text: \`[e23] uv_async_init(loop, handle, cb=0) rc=\${rc}\`, level: "info" });
      } catch (e) {
        post("log", { text: \`[e23] uv_async_init(cb=0) threw: \${(e as Error).message}\`, level: "warn" });
      }

      // Try uv_async_send on the handle (even if init returned non-zero,
      // it might have partially set things up; we want to see if the
      // export call itself trips JSPI).
      try {
        const sendRc = ex.uvAsyncSend?.(handlePtr);
        post("log", { text: \`[e23] uv_async_send(handle) rc=\${sendRc}  (call from host JS while _start suspended did NOT trap)\`, level: "info" });
      } catch (e) {
        post("log", { text: \`[e23] uv_async_send threw: \${(e as Error).message}\`, level: "warn" });
      }
    }
  } catch (probeErr) {
    post("log", { text: \`[e23] probe-after-tsfn threw: \${(probeErr as Error).message}\`, level: "warn" });
  }
`;

function patchWorker() {
  const src = readFileSync(workerPath, "utf8");
  if (src.includes(PROBE_MARKER)) {
    throw new Error("worker.ts already has probe markers — refusing to patch twice");
  }
  // Insert after-bind probe right after the `napi.bindInstance` post log.
  const bindAnchor = `post("log", { text: "emnapi bound; running _start…", level: "info" });`;
  if (!src.includes(bindAnchor)) {
    throw new Error("could not find bindInstance anchor in worker.ts");
  }
  // Insert after-tsfn probe inside `tryInstallTsfnDispatch` once it
  // succeeds — gives us a wasm-export-callable site after _start has
  // suspended at least once on a JSPI import.
  const tsfnAnchor = `post("log", { text: \`[runtime] TSFN dispatch installed (handle=\${handle}); reverse-RPC dispatches route via napi_call_threadsafe_function\`, level: "info" });`;
  if (!src.includes(tsfnAnchor)) {
    throw new Error("could not find tsfn install anchor in worker.ts");
  }
  const patched = src
    .replace(bindAnchor, `${bindAnchor}\n${PROBE_BLOCK_AFTER_BIND}`)
    .replace(tsfnAnchor, `${tsfnAnchor}\n${PROBE_BLOCK_AFTER_TSFN}`);
  writeFileSync(workerPath, patched, "utf8");
}

function revertWorker(original) {
  writeFileSync(workerPath, original, "utf8");
}

const PROBE_TEST_SCRIPT = `
// Stay alive long enough for TSFN dispatch to install (which only
// happens when dispatchOnLibuvTick is first invoked — a reverse-RPC
// from a napi callback).  Need at least one napi callback round-trip;
// process.nextTick chains and a setTimeout exercise both edges.
process.nextTick(() => {
  console.log('e23 probe: nextTick fired');
});
setTimeout(() => {
  console.log('e23 probe: setTimeout fired');
  setTimeout(() => { console.log('e23 probe: 2nd timer'); process.exit(0); }, 100);
}, 100);
`;

async function runProbe() {
  console.log("[e23] reading worker.ts…");
  const original = readFileSync(workerPath, "utf8");

  let viteProc = null;
  let browser = null;
  let allLogs = [];
  try {
    console.log("[e23] patching worker.ts with probe blocks…");
    patchWorker();
    console.log("[e23] starting vite…");
    viteProc = await startVite();
    console.log("[e23] launching chromium…");
    browser = await launchChromium();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      allLogs.push(t);
      if (/\[e23\]|_start ran/.test(t)) {
        console.log("  >", t);
      }
    });
    page.on("pageerror", (err) => {
      allLogs.push("pageerror: " + err.message);
      console.log("  ! pageerror:", err.message);
    });
    const enc = encodeURIComponent(PROBE_TEST_SCRIPT);
    const url = "http://localhost:" + VITE_PORT + "/?script=" + enc;
    console.log("[e23] navigating to", url.slice(0, 80) + "…");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    // Wait up to 25s for _start sentinel (matches the test runner's
    // SENTINEL_RE pattern).  Scrape DOM #log innerText (logs are span
    // children of <div id="log">), not page console events.
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
    // Extract all e23-tagged lines.
    const probeLines = lastLog.split("\n").filter(l => l.includes("[e23]"));
    console.log("\n=== E23 PROBE OUTPUT ===");
    for (const l of probeLines) console.log(l);
    console.log("=== END E23 PROBE ===\n");
    const sentinelMatch = lastLog.match(/_start ran[^\n]+/);
    console.log("[e23] sentinel:", sentinelMatch ? sentinelMatch[0] : "(not seen — wasm may have hung)");
    if (!probeLines.length) {
      console.log("[e23] (no probe lines captured; first 60 chars of last log block):");
      console.log(lastLog.slice(0, 2000));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
    console.log("[e23] reverting worker.ts…");
    revertWorker(original);
  }
}

runProbe().catch((e) => {
  console.error("[e23] FATAL:", e);
  process.exitCode = 1;
});
