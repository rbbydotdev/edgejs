// Phase 1 ESM smoke test — single SourceTextModule with no deps.
// Exercises: create_source_text, link (empty linker), instantiate,
// evaluate (via blob: URL trampoline), get_namespace.

const vm = require('vm');

(async () => {
  const m = new vm.SourceTextModule('export const answer = 42;');
  await m.link(() => { throw new Error('no deps expected'); });
  await m.evaluate();
  console.log('answer:', m.namespace.answer);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
