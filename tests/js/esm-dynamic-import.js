// Phase 3 ESM — dynamic import() inside source resolves via the
// user's importModuleDynamically callback registered on a
// vm.SourceTextModule.
//
// Path: blob runs in browser-V8, source has import("./child.mjs")
// rewritten to __edgeDynImport(...), host's __edgeDynImportImpl
// calls into lib's installed dispatcher (esm-via-blob-import policy
// wrapped it around lib's default), which prefers the per-URL
// registry populated by registerModule, finds the user's wrapped
// importModuleDynamically callback, fires it, returns the namespace.

const vm = require('vm');

(async () => {
  const child = new vm.SourceTextModule(
    'export const value = "from-child";\n',
    { identifier: 'child.mjs' },
  );
  await child.link(() => { throw new Error('child has no deps'); });
  await child.evaluate();

  const parent = new vm.SourceTextModule(
    'export const probe = async () => { const m = await import("./child.mjs"); return m.value; };\n',
    {
      identifier: 'parent.mjs',
      importModuleDynamically: (specifier /* , referrer, attributes */) => {
        if (specifier === './child.mjs') return child;
        throw new Error('unknown specifier: ' + specifier);
      },
    },
  );
  await parent.link(() => { throw new Error('parent has no static deps'); });
  await parent.evaluate();

  const value = await parent.namespace.probe();
  console.log('dyn:', value);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
