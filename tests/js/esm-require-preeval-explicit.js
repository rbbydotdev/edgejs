// b₁ explicit-API path: user calls edgejs.preloadEsm([...]) at startup;
// later sync require('./x.mjs') returns the cached namespace.
//
// We populate the cache directly to test the lookup path; the auto-scan
// path is tested by a separate test that uses real require() syntax.
// Driving evaluateSync goes through __edgeModuleWrap because
// vm.SourceTextModule only exposes the async evaluate publicly —
// evaluateSync is internal-only on the JS class (reachable only via
// the wrap binding or via lib's require(esm) chain, which needs FS
// fixtures the harness doesn't write).

(async () => {
  const url = 'file:///synthetic/test.mjs';
  const ns = { value: 'preloaded-explicitly' };
  globalThis.__edgePreEvalEsmCache.set(url, ns);

  const moduleWrap = globalThis.__edgeModuleWrap;
  if (!moduleWrap) throw new Error('__edgeModuleWrap not exposed');
  const w = new moduleWrap.ModuleWrap(url, undefined, '// (no source needed; preloaded)\n');
  w.link([]);
  const result = w.evaluateSync('test.mjs', '<eval>');
  console.log('value:', result?.value);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
