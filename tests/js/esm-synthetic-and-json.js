// vm.SyntheticModule + JSON-shaped exports.  Lib's JSON-import
// translator builds a ModuleWrap with `exportNames=['default']` and a
// callback that calls `this.setExport('default', JSON.parse(source))`.
// Our `create_synthetic` captures the callback; `runSyntheticEvalSteps`
// invokes it with a proxy `this` whose setExport writes to
// record.namespace; the synthesized blob source inlines the values via
// JSON.stringify so browser-V8 import sees real ESM exports.
//
// Coverage:
//   - SyntheticModule with just `default` (JSON pattern)
//   - SyntheticModule with multiple named exports
//   - SyntheticModule used as a static dep of a SourceTextModule
//     (validates parent's blob-URL specifier rewrite picks up the
//     synthetic dep's URL).

const vm = require('vm');

(async () => {
  // 1. Default-only synthetic (the JSON-import shape).
  const data = { greeting: 'hello', count: 42, nested: { ok: true } };
  const json = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', data);
  }, { identifier: 'data.json' });
  await json.link(() => {});
  await json.evaluate();
  const j = json.namespace.default;
  console.log('json.greeting:', j.greeting);
  console.log('json.count:', j.count);
  console.log('json.nested.ok:', j.nested.ok);

  // 2. Multi-export synthetic.
  const multi = new vm.SyntheticModule(['a', 'b', 'c'], function () {
    this.setExport('a', 1);
    this.setExport('b', 'two');
    this.setExport('c', [3, 3, 3]);
  }, { identifier: 'multi.synthetic' });
  await multi.link(() => {});
  await multi.evaluate();
  console.log('multi.a:', multi.namespace.a);
  console.log('multi.b:', multi.namespace.b);
  console.log('multi.c-sum:', multi.namespace.c.reduce((a, b) => a + b, 0));

  // 3. SourceTextModule importing a SyntheticModule by static specifier.
  const jsonDep = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', { name: 'edge.js', version: 1 });
  }, { identifier: 'package.json' });
  await jsonDep.link(() => {});

  const parent = new vm.SourceTextModule(
    'import pkg from "./package.json" with { type: "json" };\n' +
    'export const summary = pkg.name + "@" + pkg.version;\n',
    { identifier: 'parent.mjs' },
  );
  await parent.link((spec) => {
    if (spec === './package.json') return jsonDep;
    throw new Error('unknown: ' + spec);
  });
  await parent.evaluate();
  console.log('summary:', parent.namespace.summary);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
