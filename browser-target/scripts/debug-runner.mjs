#!/usr/bin/env node
// debug-runner.mjs — start the dev server with the debug-built wasm
// in place so the user can open the page in Chrome and use DevTools
// to set C++-level breakpoints (via the "C/C++ DevTools Support"
// extension or Chrome's built-in DWARF support).
//
// Usage:
//   1. Build the debug wasm:
//        EDGE_DEBUG_BUILD=1 SKIP_DEPS_UPDATE=1 ./wasix/build-wasix.sh
//   2. Start this runner (it swaps edgejs.wasm to the debug variant):
//        node scripts/debug-runner.mjs path/to/test.js
//   3. Open the printed URL in Chrome (must be Chrome, not Chromium —
//      DWARF extension support is better in stable Chrome).
//   4. Open DevTools → Sources panel → wasm file in tree.  Expand —
//      C++ source paths from the DWARF info appear.  Set breakpoints,
//      reload the page, step through.
//   5. Ctrl+C this runner — it restores the production edgejs.wasm.
//
// The runner DOES NOT auto-close the browser — you keep it open and
// step through interactively.  When done, close the browser tab AND
// Ctrl+C this script.
//
// Prerequisites:
//   - Chrome 130+ (built-in DWARF support is best in recent stable)
//     OR install the "C/C++ DevTools Support (DWARF)" extension from
//     the Chrome Web Store and enable it.
//   - The debug build outputs ~150+ MB wasm — page load takes longer
//     than the production build.

import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, VITE_PORT, killProc } from "./_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const browserTarget = resolve(here, "..");
const prodWasm = resolve(browserTarget, "edgejs.wasm");
const debugWasm = resolve(browserTarget, "edgejs-debug.wasm");
const prodBackup = resolve(browserTarget, "edgejs.wasm.prod-backup");

const testPath = process.argv[2];
if (!testPath) {
  console.error("usage: node scripts/debug-runner.mjs <path-to-test.js>");
  console.error("       (relative paths resolved from cwd)");
  process.exit(2);
}
const resolvedTestPath = resolve(process.cwd(), testPath);
if (!existsSync(resolvedTestPath)) {
  console.error(`test file not found: ${resolvedTestPath}`);
  process.exit(2);
}

if (!existsSync(debugWasm)) {
  console.error(`debug wasm not found: ${debugWasm}`);
  console.error("Build it first:  EDGE_DEBUG_BUILD=1 SKIP_DEPS_UPDATE=1 ./wasix/build-wasix.sh");
  process.exit(2);
}

console.log("[debug-runner] backing up prod wasm + installing debug wasm");
if (existsSync(prodWasm)) copyFileSync(prodWasm, prodBackup);
copyFileSync(debugWasm, prodWasm);

let viteProc = null;
function cleanup() {
  console.log("\n[debug-runner] restoring prod wasm");
  if (existsSync(prodBackup)) copyFileSync(prodBackup, prodWasm);
  if (viteProc) killProc(viteProc);
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

const script = readFileSync(resolvedTestPath, "utf8");
const encoded = encodeURIComponent(script);
const url = `http://localhost:${VITE_PORT}/?script=${encoded}`;

console.log("[debug-runner] starting vite…");
viteProc = await startVite();

console.log("\n" + "=".repeat(72));
console.log("  WASM DEBUG SESSION");
console.log("=".repeat(72));
console.log("");
console.log(`  Test:      ${testPath}`);
console.log(`  URL:       ${url}`);
console.log("");
console.log("  Next steps:");
console.log("    1. Open the URL above in Chrome (Chromium also works).");
console.log("    2. Open DevTools (Cmd+Option+I / F12).");
console.log("    3. Sources panel → find 'edgejs.wasm' under the file tree.");
console.log("    4. Wait for the wasm to load (takes a few seconds with DWARF).");
console.log("    5. With C++ DevTools Support: expand wasm → see C++ source paths.");
console.log("       Without extension: Chrome 130+ has built-in DWARF support too,");
console.log("       though the extension gives a smoother experience.");
console.log("    6. Set breakpoints by clicking line numbers in C++ source.");
console.log("    7. Reload the page (Cmd+R) to hit breakpoints at startup.");
console.log("");
console.log("  Ctrl+C this runner when done (restores production wasm).");
console.log("=".repeat(72) + "\n");

// Keep alive forever (until SIGINT).
await new Promise(() => {});
