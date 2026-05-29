// Phase 4 ESM — import.meta.url returns the lib-provided identifier
// (not the opaque blob: URL).  The blob preamble injects
// __edgeImportMeta = { url: <identifier> } and rewrites import.meta
// references to that local; without the rewrite, the browser would
// expose blob:https://... which leaks the trampoline.

const vm = require('vm');

(async () => {
  const m = new vm.SourceTextModule(
    'export const url = import.meta.url;\nexport const isString = typeof import.meta.url === "string";\n',
    { identifier: 'file:///hello.mjs' },
  );
  await m.link(() => { throw new Error('no deps'); });
  await m.evaluate();
  console.log('url:', m.namespace.url);
  console.log('isString:', m.namespace.isString);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
