// Phase 1 ESM — three modules in a re-export chain.
//   leaf.mjs       export const v = 7
//   middle.mjs     export { v } from './leaf.mjs'
//   top.mjs        import { v } from './middle.mjs'; export const out = v * 3

const vm = require('vm');

(async () => {
  const leaf = new vm.SourceTextModule(
    'export const v = 7;\n',
    { identifier: 'leaf.mjs' },
  );
  await leaf.link(() => { throw new Error('no deps'); });

  const middle = new vm.SourceTextModule(
    'export { v } from "./leaf.mjs";\n',
    { identifier: 'middle.mjs' },
  );
  await middle.link((s) => s === './leaf.mjs' ? leaf : (() => { throw new Error('bad: ' + s); })());

  const top = new vm.SourceTextModule(
    'import { v } from "./middle.mjs";\nexport const out = v * 3;\n',
    { identifier: 'top.mjs' },
  );
  await top.link((s) => s === './middle.mjs' ? middle : (() => { throw new Error('bad: ' + s); })());

  await top.evaluate();
  console.log('out:', top.namespace.out);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
