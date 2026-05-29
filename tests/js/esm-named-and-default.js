// Phase 1 ESM — two modules, parent imports named + default from child.
// Exercises the dependency-rewrite path: parent's `from "./child"` gets
// rewritten to the child's blob: URL before the parent blob is minted.

const vm = require('vm');

(async () => {
  const child = new vm.SourceTextModule(
    'export const name = "child";\nexport default 42;\n',
    { identifier: 'child.mjs' },
  );
  await child.link(() => { throw new Error('child has no deps'); });

  const parent = new vm.SourceTextModule(
    'import answer, { name } from "./child.mjs";\nexport const greeting = name + ":" + answer;\n',
    { identifier: 'parent.mjs' },
  );
  await parent.link((specifier) => {
    if (specifier === './child.mjs') return child;
    throw new Error('unknown specifier: ' + specifier);
  });
  await parent.evaluate();

  console.log('greeting:', parent.namespace.greeting);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
