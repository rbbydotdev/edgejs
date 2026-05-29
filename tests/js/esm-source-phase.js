// Source-phase import support — `import source X from "./mod.wasm"`
// resolves to the underlying module's source object (for Wasm, the
// compiled WebAssembly.Module).  Lib stashes this via
// `module.setModuleSourceObject(compiled)` in
// internal/modules/esm/translators.js:625 and reads back via
// `m[kWrap].getModuleSourceObject()` in vm/module.js:541 when the
// import phase is kSourcePhase.
//
// We verify the round-trip via the module_wrap binding directly
// (vm.SyntheticModule doesn't expose set/getModuleSourceObject on its
// user-facing surface).  The `with { type: "wasm" }` import syntax
// can't be tested end-to-end here because the harness doesn't fetch
// .wasm files; we test the underlying napi storage that the full
// path relies on.

const vm = require('vm');
void vm;

const binding = globalThis.__edgeModuleWrap;
if (!binding || typeof binding.ModuleWrap !== 'function') {
  console.error('FAIL: __edgeModuleWrap binding unavailable');
  process.exit(1);
}

try {
  const { ModuleWrap, kSourcePhase, kEvaluationPhase } = binding;
  // Synthetic ModuleWrap (4-arg form: url, ctx, exportNames, evalSteps).
  const wrap = new ModuleWrap(
    'mod.wasm',
    undefined,
    ['default'],
    function () { this.setExport('default', null); },
  );

  // Initial state: no source object set → lib's caller throws
  // ERR_SOURCE_PHASE_NOT_DEFINED.
  const initial = wrap.getModuleSourceObject();
  console.log('initial-defined:', initial !== undefined ? 'yes' : 'no');

  // Set + read back.
  const obj = { kind: 'wasm-module-placeholder', exports: ['add', 'sub'] };
  wrap.setModuleSourceObject(obj);
  const got = wrap.getModuleSourceObject();
  console.log('roundtrip-identity:', got === obj ? 'yes' : 'no');
  console.log('roundtrip-kind:', got.kind);
  console.log('roundtrip-exports:', got.exports.join(','));

  // Phase constants are exposed by the binding.
  console.log('kSourcePhase:', kSourcePhase);
  console.log('kEvaluationPhase:', kEvaluationPhase);
} catch (e) {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
}
