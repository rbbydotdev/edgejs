// b₁ explicit-API path: user calls edgejs.preloadEsm([...]) at startup;
// later sync require('./x.mjs') returns the cached namespace.
//
// We build the .mjs source as a data: URL so the test is self-contained
// (no FS fixture).  The require() call uses the same data: URL.

(async () => {
  // We don't have a real .mjs file fixture; use vm.SourceTextModule to
  // create one in lib's loader, then preload it.  This exercises the
  // OUR-cache path, not lib's loader cache.
  //
  // Approach: directly populate the cache via globalThis API to test
  // the lookup path; the auto-scan path is tested by a separate test
  // that uses real require() syntax.
  const ns = { value: 'preloaded-explicitly' };
  globalThis.__edgePreEvalEsmCache.set('file:///synthetic/test.mjs', ns);

  // Now construct a wrap with that URL and call evaluateSync — should
  // hit our cache and return ns instead of throwing.
  // (We exercise via the same internalBinding the require(esm) path uses.)
  const moduleWrap = globalThis.__edgeModuleWrap;
  if (!moduleWrap) throw new Error('__edgeModuleWrap not exposed');
  const w = new moduleWrap.ModuleWrap('file:///synthetic/test.mjs', undefined, '// (no source needed; preloaded)\n');
  w.link([]);
  // evaluateSync(filename, parentFilename) — these are diagnostic strings
  const result = w.evaluateSync('test.mjs', '<eval>');
  // result should be the namespace from cache
  console.log('value:', result?.value);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
