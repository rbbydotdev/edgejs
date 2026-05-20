#!/usr/bin/env node
// Diff a native (napi_wasmer --trace-wasi) JSONL trace against a browser
// (downloaded from the harness page) JSONL trace.  Both files share the
// schema:
//   {"t_ms": <number>, "category": "wasi"|"wasix"|"napi"|..., "name": "<sym>", "target": "<full>", "fields": {...}}
//
// Output: the FIRST point of divergence (by (category, name) sequence),
// then the next few records on each side for context.
//
// Usage:
//   node scripts/diff-traces.mjs <native.jsonl> <browser.jsonl> [--full]
//
// --full prints every divergent record instead of stopping at the first.

import { readFileSync } from "node:fs";

function parseTrace(path, options = {}) {
  const text = readFileSync(path, "utf8");
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      // "internal" spans are wasmer-wasix runner setup (prepare_webc_env,
      // bootstrap) that the browser doesn't emit — skip for diff parity.
      if (r.category === "internal" && !options.keepInternal) continue;
      records.push(r);
    } catch (e) {
      console.warn(`[diff] skipped malformed line in ${path}: ${line.slice(0, 60)}…`);
    }
  }
  return records;
}

function key(r) {
  return `${r.category}.${r.name}`;
}

function fmt(r) {
  const t = r.t_ms != null ? `${r.t_ms.toFixed(2)}ms` : "?ms";
  const fields = r.fields ? Object.entries(r.fields).slice(0, 6).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ") : "";
  return `[${t.padStart(10)}] ${key(r).padEnd(45)} ${fields}`;
}

function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const paths = args.filter((a) => !a.startsWith("--"));
  if (paths.length !== 2) {
    console.error("usage: diff-traces.mjs <native.jsonl> <browser.jsonl> [--full]");
    process.exit(2);
  }
  const [nativePath, browserPath] = paths;
  const native = parseTrace(nativePath);
  const browser = parseTrace(browserPath);

  console.log(`native:  ${native.length.toString().padStart(6)} records  (${nativePath})`);
  console.log(`browser: ${browser.length.toString().padStart(6)} records  (${browserPath})`);
  console.log("");

  let divergences = 0;
  const max = Math.max(native.length, browser.length);
  for (let i = 0; i < max; i++) {
    const n = native[i];
    const b = browser[i];
    if (!n) {
      console.log(`#${i.toString().padStart(5)}  native EOF · browser continues:`);
      console.log(`           ${fmt(b)}`);
      divergences++;
      if (!full) break;
      continue;
    }
    if (!b) {
      console.log(`#${i.toString().padStart(5)}  browser EOF · native continues:`);
      console.log(`           ${fmt(n)}`);
      divergences++;
      if (!full) break;
      continue;
    }
    if (key(n) !== key(b)) {
      console.log(`#${i.toString().padStart(5)}  DIVERGE on ${key(n)} vs ${key(b)}:`);
      console.log(`  native:  ${fmt(n)}`);
      console.log(`  browser: ${fmt(b)}`);
      // Context: the 3 records before and after, on both sides
      console.log("  --- native context ---");
      for (let j = Math.max(0, i - 2); j < Math.min(native.length, i + 4); j++) {
        const marker = j === i ? ">>" : "  ";
        console.log(`  ${marker} #${j.toString().padStart(5)}  ${fmt(native[j])}`);
      }
      console.log("  --- browser context ---");
      for (let j = Math.max(0, i - 2); j < Math.min(browser.length, i + 4); j++) {
        const marker = j === i ? ">>" : "  ";
        console.log(`  ${marker} #${j.toString().padStart(5)}  ${fmt(browser[j])}`);
      }
      divergences++;
      if (!full) {
        console.log("\n(pass --full to see all divergences)");
        break;
      }
    }
  }
  if (divergences === 0) {
    console.log("✓ no divergence: traces match on (category, name) sequence");
  } else {
    console.log(`\n${divergences} divergence${divergences > 1 ? "s" : ""} found.`);
  }
}

main();
