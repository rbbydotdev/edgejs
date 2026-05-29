// Phase 3 phase-aware dynamic import: import.source('m') routes
// through __edgeDynImportSource and ends up calling lib's dynamic
// callback with kSourcePhase (not the default evaluation phase).
//
// Pre-A3 fix: both import('m') and import.source('m') reached the
// callback with phase='evaluation' — source-phase semantics were
// silently dropped.  This test verifies the phase argument is
// preserved.
//
// We catch the ERR_VM_MODULE_NOT_MODULE that lib's wrapper throws
// when the user's callback for source-phase returns a non-Module
// (lib expects a vm.Module whose wrap has a source object set).
// That's the right behavior — what we care about is whether the
// phase argument made it to the callback before the validation
// failure.

const vm = require('vm');

(async () => {
  const child = new vm.SourceTextModule(
    'export const value = "from-child-eval";\n',
    { identifier: 'child.mjs' },
  );
  await child.link(() => { throw new Error('child has no deps'); });
  await child.evaluate();

  const observed = [];
  const parent = new vm.SourceTextModule(
    [
      "export const probeEval = async () => {",
      "  const m = await import('./child.mjs');",
      "  return m.value;",
      "};",
      "export const probeSource = async () => {",
      "  try { return await import.source('./child.mjs'); }",
      "  catch (e) { return { caught: true, code: e.code || e.message }; }",
      "};",
    ].join('\n'),
    {
      identifier: 'parent.mjs',
      importModuleDynamically: (specifier, _ref, _attrs, phase) => {
        observed.push(phase);
        if (phase === 'source') {
          // Lib's wrapper will reject our return (we'd need a vm.Module
          // with a source object set, which requires more setup).  The
          // rejection is fine for this test — we already observed phase.
          return { sentinelForPhase: phase };
        }
        if (specifier === './child.mjs') return child;
        throw new Error('unknown specifier: ' + specifier);
      },
    },
  );
  await parent.link(() => { throw new Error('parent has no static deps'); });
  await parent.evaluate();

  const evalValue = await parent.namespace.probeEval();
  const srcResult = await parent.namespace.probeSource();

  console.log('eval value:', evalValue);
  console.log('source caught:', srcResult.caught === true);
  console.log('phases observed:', observed.join(','));
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
