#!/usr/bin/env node
// ESM-via-blob feasibility probe for the ESM-no-asyncify plan.
//
// Phase 0 of the ESM-via-JSPI plan needs two facts confirmed in the real
// browser-target environment (Vite + module worker + cross-origin
// isolation):
//
//   P0.1 — a DedicatedWorker can `await import(blobUrl)` where blobUrl
//          comes from URL.createObjectURL(new Blob([src], {type:'text/javascript'}))
//          and get a live ES Module namespace back.
//
//   P0.2 — the same DedicatedWorker can build a TWO-module graph by
//          generating two blobs and rewriting the parent's import
//          specifier to point at the child's blob: URL.  This is the
//          mechanism the real bridge will use to wire dependencies.
//
// Both probes run inside a fresh DedicatedWorker spawned from page.evaluate
// (NOT the wasm runtime worker — we just need a module worker context).
// No edge.js, no wasm; isolates the question of "does the browser+Vite+CSP
// stack support `import(blob:)` from a worker?"

import { startVite, launchChromium, killProc, VITE_PORT } from "./_runner-common.mjs";

const PROBE_SCRIPT = `
async function runProbes() {
  const results = { p01: null, p02: null };

  // P0.1 — single-module blob import.
  try {
    const src = "export const answer = 42; export const greet = (n) => 'hi ' + n;";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const ns = await import(url);
    URL.revokeObjectURL(url);
    if (ns.answer === 42 && ns.greet("ada") === "hi ada") {
      results.p01 = { ok: true };
    } else {
      results.p01 = { ok: false, why: "namespace mismatch: " + JSON.stringify({ answer: ns.answer, greet: typeof ns.greet }) };
    }
  } catch (e) {
    results.p01 = { ok: false, why: "threw: " + (e && e.message || String(e)) };
  }

  // P0.2 — two-module graph; parent imports a named export from child.
  try {
    const childSrc = "export const childValue = 7; export function double(n){return n*2;}";
    const childUrl = URL.createObjectURL(new Blob([childSrc], { type: "text/javascript" }));
    // Parent's import specifier is rewritten to be the child's blob: URL
    // — exactly what the real ESM bridge will do for each dependency.
    const parentSrc =
      "import { childValue, double } from " + JSON.stringify(childUrl) + ";\\n" +
      "export const parentValue = childValue + 1;\\n" +
      "export const tripled = double(childValue) + childValue;\\n" +
      "export const importMetaUrl = import.meta.url;";
    const parentUrl = URL.createObjectURL(new Blob([parentSrc], { type: "text/javascript" }));
    const ns = await import(parentUrl);
    URL.revokeObjectURL(parentUrl);
    URL.revokeObjectURL(childUrl);
    const expectParent = 8;          // 7 + 1
    const expectTripled = 21;        // (7*2) + 7
    const importMetaIsBlob = typeof ns.importMetaUrl === "string"
      && ns.importMetaUrl.startsWith("blob:");
    if (ns.parentValue === expectParent && ns.tripled === expectTripled && importMetaIsBlob) {
      results.p02 = { ok: true, importMetaUrl: ns.importMetaUrl };
    } else {
      results.p02 = {
        ok: false,
        why: "values: " + JSON.stringify({
          parentValue: ns.parentValue,
          tripled: ns.tripled,
          importMetaUrl: ns.importMetaUrl,
        }),
      };
    }
  } catch (e) {
    results.p02 = { ok: false, why: "threw: " + (e && e.message || String(e)) };
  }

  postMessage({ kind: "probe-result", results });
}
runProbes().catch((e) => postMessage({ kind: "probe-error", message: e && e.message || String(e) }));
`;

async function main() {
  let viteProc, browser;
  try {
    viteProc = await startVite();
    browser = await launchChromium();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });

    // Run the probe in page context.  Spawns a module-type DedicatedWorker
    // from a blob URL (the canonical "blob-trampoline" pattern shipped by
    // Vite/esbuild/Parcel) and awaits its result postMessage.
    const result = await page.evaluate(async (probeScript) => {
      const workerBlob = new Blob([probeScript], { type: "text/javascript" });
      const workerUrl = URL.createObjectURL(workerBlob);
      const worker = new Worker(workerUrl, { type: "module" });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("worker timed out (10s)")), 10_000);
          worker.onmessage = (e) => {
            clearTimeout(timer);
            if (e.data?.kind === "probe-result") resolve(e.data.results);
            else if (e.data?.kind === "probe-error") reject(new Error(e.data.message));
            else reject(new Error("unexpected message: " + JSON.stringify(e.data)));
          };
          worker.onerror = (e) => {
            clearTimeout(timer);
            reject(new Error("worker.onerror: " + (e.message || "(no message)")));
          };
        });
      } finally {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
      }
    }, PROBE_SCRIPT);

    const p01ok = result.p01?.ok === true;
    const p02ok = result.p02?.ok === true;

    process.stdout.write(`P0.1 single-blob import:   ${p01ok ? "PASS" : "FAIL"}` + (p01ok ? "\n" : `  (${result.p01?.why})\n`));
    process.stdout.write(`P0.2 multi-blob graph:     ${p02ok ? "PASS" : "FAIL"}` + (p02ok ? `  (import.meta.url=${result.p02.importMetaUrl.slice(0, 60)}...)\n` : `  (${result.p02?.why})\n`));

    if (p01ok && p02ok) {
      process.stdout.write("probe-esm-blob: OK — Phase 0 unblocked, proceed to Phase 1.\n");
      process.exit(0);
    } else {
      process.stderr.write("probe-esm-blob: FAIL — see results above.\n");
      process.exit(1);
    }
  } finally {
    if (browser) await browser.close();
    if (viteProc) killProc(viteProc);
  }
}

main().catch((e) => {
  process.stderr.write(`probe-esm-blob: error ${e?.stack ?? e}\n`);
  process.exit(2);
});
