// b₁ API path: user calls edgejs.preloadEsm with a real specifier
// (we use a data: URL so no FS fixture is needed), then constructs a
// ModuleWrap with the same URL and calls evaluateSync — our handler
// should hit the cache populated by the preload.

(async () => {
  if (typeof globalThis.edgejs?.preloadEsm !== 'function') {
    throw new Error('edgejs.preloadEsm not installed');
  }

  // Use a data: URL so no FS fixture is needed.  The import() call
  // resolves the source natively, evaluation runs in browser-V8,
  // namespace gets cached against the data: URL.
  const url = 'data:text/javascript,export%20const%20value%20=%20%22preloaded-via-api%22%3B';
  await globalThis.edgejs.preloadEsm([url]);

  // Verify cache hit.
  if (!globalThis.__edgePreEvalEsmCache.has(url)) {
    throw new Error('cache did not get populated');
  }
  const cached = globalThis.__edgePreEvalEsmCache.get(url);
  console.log('cached value:', cached.value);

  // Now exercise the evaluate_sync path via __edgeModuleWrap to
  // confirm the handler reads the cache (see explicit-test comment
  // for why this isn't a Node-portable construction).
  const moduleWrap = globalThis.__edgeModuleWrap;
  const w = new moduleWrap.ModuleWrap(url, undefined, '// (preloaded; source irrelevant)\n');
  w.link([]);
  const result = w.evaluateSync('preloaded.mjs', '<eval>');
  console.log('evaluateSync value:', result?.value);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
