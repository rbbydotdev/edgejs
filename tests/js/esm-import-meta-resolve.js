// import.meta.resolve(specifier) — verifies the per-module resolve
// closure baked into the blob preamble by synthesizePreamble.  For
// statically-known specifiers we return the bound URL (a blob: URL
// or /_edge_esm/<id>); for absolute URLs we fall back to
// `new URL(specifier, importMeta.url).href`; for unknown bare
// specifiers we throw ERR_MODULE_NOT_FOUND.

const vm = require('vm');

(async () => {
  const child = new vm.SourceTextModule(
    'export const x = 1;\n',
    { identifier: 'child.mjs' },
  );
  await child.link(() => { throw new Error('no deps'); });

  const parent = new vm.SourceTextModule(
    [
      'import { x } from "./child.mjs";',
      'export const childResolved = import.meta.resolve("./child.mjs");',
      'export const absResolved = import.meta.resolve("https://example.com/lib.mjs");',
      'export const baseUrl = import.meta.url;',
      'export const xVal = x;',
      'export function tryUnknown() {',
      '  try { return { url: import.meta.resolve("./nope-not-registered.mjs") }; }',
      '  catch (e) { return { err: e.code || e.name || "unknown" }; }',
      '}',
    ].join('\n'),
    { identifier: 'parent.mjs' },
  );

  await parent.link((spec) => {
    if (spec === './child.mjs') return child;
    throw new Error('unknown: ' + spec);
  });
  await parent.evaluate();

  console.log('baseUrl:', parent.namespace.baseUrl);
  console.log('childResolved-blob?:',
    /^blob:|^\/_edge_esm\//.test(parent.namespace.childResolved) ? 'yes' : parent.namespace.childResolved);
  console.log('absResolved:', parent.namespace.absResolved);
  console.log('xVal:', parent.namespace.xVal);
  const unknown = parent.namespace.tryUnknown();
  // Bare relative specifier without a base scheme also resolves via
  // `new URL` against parent.mjs (which is what Node's resolver does
  // for already-string-typed URLs).  Confirm the URL came out:
  console.log('unknown-resolved?:', unknown.url ? 'fallback-url' : ('err=' + unknown.err));
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
