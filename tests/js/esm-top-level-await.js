// Phase 2 ESM — top-level await. Module evaluation must wait on a
// resolved Promise at the top level; the browser's import() handles
// this naturally as long as evaluate returns a Promise (lib awaits it
// in module_job.js:430).

const vm = require('vm');

(async () => {
  const m = new vm.SourceTextModule(
    'const v = await Promise.resolve(99);\nexport const result = v + 1;\n',
    { identifier: 'tla.mjs' },
  );
  await m.link(() => { throw new Error('no deps'); });
  await m.evaluate();
  console.log('result:', m.namespace.result);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
