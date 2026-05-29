// Cyclic ES module graph — A imports from B which imports from A.
// Verifies the SW-URL fallback in napi-host/esm-registry.ts:
// blob: URLs can't be pre-reserved for cyclic graphs, so the
// registry detects the cycle, assigns stable /_edge_esm/<id> paths,
// publishes sources to the SW via worker → page → SW, then calls
// `import(rootUrl)`.  The browser sees real cross-referencing module
// URLs and V8's bytecode-level live-binding makes the cycle work.

const vm = require('vm');

(async () => {
  // Valid ESM cycle: each module exports its own values immediately
  // and defers access to the cyclic import via a function.  V8
  // evaluates A first (the entry); A's body would TDZ on B's exports
  // if it accessed them eagerly, so we read from B inside `compute`
  // (called AFTER both modules complete evaluation).
  const a = new vm.SourceTextModule(
    'import { readA } from "./b.mjs";\nexport const aVal = "from-A";\nexport const compute = () => readA() + "+" + aVal;\n',
    { identifier: 'a.mjs' },
  );
  const b = new vm.SourceTextModule(
    'import { aVal } from "./a.mjs";\nexport const readA = () => aVal;\n',
    { identifier: 'b.mjs' },
  );

  await a.link((specifier, referrer) => {
    if (specifier === './b.mjs') return b;
    if (specifier === './a.mjs') return a;
    throw new Error('unknown specifier: ' + specifier + ' from ' + referrer.identifier);
  });

  await a.evaluate();
  console.log('both:', a.namespace.compute());
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
