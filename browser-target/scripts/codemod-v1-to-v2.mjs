#!/usr/bin/env node
// emnapi v1 → v2 codemod for edge.js's browser-target.
//
// Walks all .ts files under browser-target/src/ and rewrites the v1
// Context APIs (handleStore.get(X)?.value, ensureHandle, addToCurrentScope)
// to their v2 equivalents (jsValueFromNapiValue, napiValueFromJsValue).
//
// Patterns rewritten (E = EXPR, A = ARG):
//   E.handleStore.get(A)?.value  →  E.jsValueFromNapiValue(A)
//   E.handleStore.get(A).value   →  E.jsValueFromNapiValue(A)
//   E.ensureHandle(A).id         →  E.napiValueFromJsValue(A)
//   E.ensureHandle(A)            →  E.napiValueFromJsValue(A)   [stmt/expr]
//   E.addToCurrentScope(A).id    →  E.napiValueFromJsValue(A)
//   E.addToCurrentScope(A)       →  E.napiValueFromJsValue(A)   [stmt/expr]
//
// Indirect patterns (cast through `unknown as { handleStore?: ... }`,
// accesses to `_next`, `_allocator`, `_values`, `_externalMemory`, or
// `handleStore` standing alone) are NOT rewritten — they're flagged for
// manual review and printed in the summary.
//
// `createEnv` call sites are also flagged for the main session.
//
// Usage:   node scripts/codemod-v1-to-v2.mjs
// Output:  edits files in-place under browser-target/src/, prints summary

import { Project, SyntaxKind } from "ts-morph";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const tsconfigPath = path.join(projectRoot, "tsconfig.json");
const srcGlob = path.join(projectRoot, "src/**/*.ts");

const project = new Project({
  tsConfigFilePath: tsconfigPath,
  skipAddingFilesFromTsConfig: true,
});
project.addSourceFilesAtPaths(srcGlob);

// Per-pattern counters; per-file rewrite logs.
const counts = {
  handleStoreGetOptionalValue: 0, // E.handleStore.get(A)?.value
  handleStoreGetValue: 0,         // E.handleStore.get(A).value
  ensureHandleId: 0,              // E.ensureHandle(A).id
  ensureHandleExpr: 0,            // E.ensureHandle(A)
  addToCurrentScopeId: 0,         // E.addToCurrentScope(A).id
  addToCurrentScopeExpr: 0,       // E.addToCurrentScope(A)
};
const fileChanges = new Map(); // file → [{ pattern, before, after, line }]
const indirectPatterns = [];   // { file, line, code }
const createEnvSites = [];     // { file, line, code }

function logChange(file, pattern, before, after, line) {
  if (!fileChanges.has(file)) fileChanges.set(file, []);
  fileChanges.get(file).push({ pattern, before, after, line });
}

// Helper: print expression text safely.
function exprText(node) {
  try { return node.getText(); } catch { return "<?>"; }
}

// A PropertyAccessExpression `X.Y` lets us recognize `E.handleStore.get(A)?.value`:
//   - .value (PropertyAccess) -> expression = E.handleStore.get(A) [CallExpression]
//   - That call's expression = E.handleStore.get [PropertyAccess: 'get']
//   - That .get's expression  = E.handleStore [PropertyAccess: 'handleStore']
// We accept both `.value` and `?.value` (the latter is a PropertyAccessExpression
// with isOptional() true when the optional chain is on the property itself, or
// the parent is a non-null/optional chain — ts-morph models `?.value` as
// PropertyAccessExpression where the question-dot token is present).

for (const sourceFile of project.getSourceFiles()) {
  const filePath = sourceFile.getFilePath();
  const relPath = path.relative(projectRoot, filePath);

  // Skip the emnapi facade itself (declares the ContextRuntimeAccess interface).
  if (relPath === "src/napi-host/emnapi.ts") continue;

  // Pass 1: handleStore.get(A)?.value AND handleStore.get(A).value
  //
  // Walk all `.value` PropertyAccessExpressions, check parent chain.
  // Replace nodes bottom-up; ts-morph re-walks safely, but to avoid
  // double-replacing inside already-rewritten text, collect replacements
  // and apply via node.replaceWithText().
  const replacementsValue = [];
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const pa = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pa.getName() !== "value") return;
    const inner = pa.getExpression(); // expected: CallExpression `E.handleStore.get(A)`
    if (inner.getKind() !== SyntaxKind.CallExpression) return;
    const call = inner.asKindOrThrow(SyntaxKind.CallExpression);
    const callee = call.getExpression(); // expected: PropertyAccess `E.handleStore.get`
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const calleePa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (calleePa.getName() !== "get") return;
    const handleStoreExpr = calleePa.getExpression(); // expected: PropertyAccess `E.handleStore`
    if (handleStoreExpr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const hsPa = handleStoreExpr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (hsPa.getName() !== "handleStore") return;

    const E = hsPa.getExpression(); // E
    const args = call.getArguments();
    if (args.length !== 1) return;
    const A = args[0];

    const before = pa.getText();
    const after = `${exprText(E)}.jsValueFromNapiValue(${exprText(A)})`;
    const isOptional = pa.hasQuestionDotToken();
    // Distinguish for counters (optional vs non-optional).
    const patternName = isOptional ? "handleStoreGetOptionalValue" : "handleStoreGetValue";
    replacementsValue.push({ node: pa, before, after, patternName, line: pa.getStartLineNumber() });
  });

  // Apply (longest first / by start descending so earlier replacements don't
  // invalidate later nodes' positions).
  replacementsValue.sort((a, b) => b.node.getStart() - a.node.getStart());
  for (const r of replacementsValue) {
    counts[r.patternName] += 1;
    logChange(relPath, r.patternName, r.before, r.after, r.line);
    r.node.replaceWithText(r.after);
  }

  // Pass 2: E.ensureHandle(A).id and E.ensureHandle(A) (standalone)
  // Pass 3: E.addToCurrentScope(A).id and E.addToCurrentScope(A) (standalone)
  for (const methodName of ["ensureHandle", "addToCurrentScope"]) {
    const replacements = [];
    sourceFile.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const call = node.asKindOrThrow(SyntaxKind.CallExpression);
      const callee = call.getExpression();
      if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return;
      const calleePa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (calleePa.getName() !== methodName) return;
      const args = call.getArguments();
      if (args.length !== 1) return;
      const E = calleePa.getExpression();
      const A = args[0];
      const afterCall = `${exprText(E)}.napiValueFromJsValue(${exprText(A)})`;

      // Check if parent is `.id` access; if so, replace the parent.
      const parent = call.getParent();
      if (parent && parent.getKind() === SyntaxKind.PropertyAccessExpression) {
        const parentPa = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        if (parentPa.getName() === "id" && parentPa.getExpression() === call) {
          const before = parentPa.getText();
          const patternName = methodName === "ensureHandle" ? "ensureHandleId" : "addToCurrentScopeId";
          replacements.push({
            node: parentPa, before, after: afterCall, patternName,
            line: parentPa.getStartLineNumber(),
          });
          return;
        }
      }
      // Otherwise: rewrite just the call.
      const before = call.getText();
      const patternName = methodName === "ensureHandle" ? "ensureHandleExpr" : "addToCurrentScopeExpr";
      replacements.push({
        node: call, before, after: afterCall, patternName,
        line: call.getStartLineNumber(),
      });
    });

    replacements.sort((a, b) => b.node.getStart() - a.node.getStart());
    for (const r of replacements) {
      counts[r.patternName] += 1;
      logChange(relPath, r.patternName, r.before, r.after, r.line);
      r.node.replaceWithText(r.after);
    }
  }

  // Indirect-pattern scan (NO rewrite).  Flag:
  //  - `handleStore` access NOT followed by `.get(X)?.value` style
  //  - any access to `_next`, `_allocator`, `_values`, `_externalMemory`
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const pa = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const name = pa.getName();
    if (name === "_next" || name === "_allocator" || name === "_values" || name === "_externalMemory") {
      indirectPatterns.push({
        file: relPath,
        line: pa.getStartLineNumber(),
        code: pa.getParentOrThrow().getText().slice(0, 240),
      });
      return;
    }
    if (name === "handleStore") {
      // Determine whether this `handleStore` is part of a `.get(X)?.value`
      // pattern we already rewrote.  After rewrite, that pattern is gone, so
      // any remaining `handleStore` access is indirect.
      indirectPatterns.push({
        file: relPath,
        line: pa.getStartLineNumber(),
        code: pa.getParentOrThrow().getText().slice(0, 240),
      });
    }
  });

  // createEnv call-site scan (NO rewrite).
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node.asKindOrThrow(SyntaxKind.CallExpression);
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const calleePa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (calleePa.getName() !== "createEnv") return;
    createEnvSites.push({
      file: relPath,
      line: call.getStartLineNumber(),
      code: call.getText(),
    });
  });

  if (fileChanges.has(relPath)) {
    sourceFile.saveSync();
  }
}

// Print summary.
console.log("=== emnapi v1 → v2 codemod summary ===\n");
console.log("Pattern counts:");
for (const [k, v] of Object.entries(counts)) {
  console.log(`  ${k.padEnd(32)} ${v}`);
}
const totalRewrites = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`  ${"TOTAL".padEnd(32)} ${totalRewrites}`);
console.log(`\nFiles touched: ${fileChanges.size}\n`);

for (const [file, changes] of fileChanges) {
  console.log(`--- ${file} (${changes.length} rewrites) ---`);
  for (const c of changes) {
    console.log(`  L${c.line}  [${c.pattern}]`);
    console.log(`    -  ${c.before}`);
    console.log(`    +  ${c.after}`);
  }
  console.log("");
}

console.log("=== Indirect patterns (NOT rewritten — manual review needed) ===");
console.log(`Total: ${indirectPatterns.length}\n`);
for (const ip of indirectPatterns) {
  console.log(`  ${ip.file}:${ip.line}  ${ip.code}`);
}

console.log("\n=== createEnv call sites (NOT rewritten — design work needed) ===");
console.log(`Total: ${createEnvSites.length}\n`);
for (const cs of createEnvSites) {
  console.log(`  ${cs.file}:${cs.line}`);
  console.log(`    ${cs.code.replace(/\s+/g, " ").slice(0, 300)}`);
}
