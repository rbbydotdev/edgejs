// Wasm module imports as ES module exports — `import { add } from
// "./math.wasm"` becomes a synthetic module whose exports are real
// WebAssembly instance exports.  Non-JSON-serializable values
// (functions, Memory, Table) flow through the
// __edgeSyntheticExports global-lookup path instead of inline JSON.
//
// We construct the synthetic module by hand here because the harness
// doesn't have a working FS path to fetch a .wasm file from.  This
// mirrors what lib's wasm-translator produces.

const vm = require('vm');

// Tiny wasm module: (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const WASM_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // type sec: (i32,i32) -> i32
  0x03, 0x02, 0x01, 0x00,                         // func sec: [func0 of type0]
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, // export "add" func0
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // code: local.get 0 1 i32.add
]);

(async () => {
  const mod = await WebAssembly.compile(WASM_BYTES);
  const instance = await WebAssembly.instantiate(mod);

  // Synthetic module representing the wasm exports.
  const wasm = new vm.SyntheticModule(
    ['add'],
    function () {
      this.setExport('add', instance.exports.add);
    },
    { identifier: 'math.wasm' },
  );
  await wasm.link(() => {});
  await wasm.evaluate();

  console.log('wasm.add(1,2):', wasm.namespace.add(1, 2));
  console.log('wasm.add(40,2):', wasm.namespace.add(40, 2));

  // Parent module imports the wasm synthetic.
  const parent = new vm.SourceTextModule(
    'import { add } from "./math.wasm" with { type: "wasm" };\n' +
    'export const sum = add(100, 23);\n',
    { identifier: 'main.mjs' },
  );
  await parent.link((spec) => {
    if (spec === './math.wasm') return wasm;
    throw new Error('unknown: ' + spec);
  });
  await parent.evaluate();
  console.log('parent.sum:', parent.namespace.sum);
})().catch((e) => {
  console.error('FAIL:', e && e.message || String(e));
  process.exit(1);
});
