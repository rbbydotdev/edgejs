// Live binding semantics — `import * as ns from "./mod"` produces a
// Module Namespace Object whose properties are live getters that read
// the underlying binding cell on every access.  Mutating an export
// inside the source module must be visible to importers reading the
// namespace property afterwards.

const vm = require('vm');

(async () => {
  // counter is exported as `let`; importer calls tick() which
  // increments it, then reads the export again and observes the new
  // value.  Snapshot-at-evaluate-time semantics would freeze counter
  // at 0; live bindings show the increment.
  const counter = new vm.SourceTextModule(
    [
      'export let counter = 0;',
      'export function tick() { counter += 1; return counter; }',
      'export function reset() { counter = 0; }',
    ].join('\n'),
    { identifier: 'counter.mjs' },
  );
  await counter.link(() => { throw new Error('no deps'); });
  await counter.evaluate();

  console.log('initial:', counter.namespace.counter);
  counter.namespace.tick();
  counter.namespace.tick();
  counter.namespace.tick();
  console.log('after-3-ticks:', counter.namespace.counter);
  counter.namespace.reset();
  console.log('after-reset:', counter.namespace.counter);

  // Iteration: Object.keys should list the exports.
  const keys = Object.keys(counter.namespace).sort();
  console.log('keys:', keys.join(','));
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
