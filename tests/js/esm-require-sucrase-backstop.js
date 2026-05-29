// b₄ Sucrase backstop: verify the policy's host-side wiring is in
// place.  The full end-to-end runSync path requires an .mjs fixture
// on the bundled FS, which the harness doesn't write — instead we
// drive both sides of the contract directly:
//
//   1. globalThis.__edgeEsmSucraseTransform exists (worker.ts wired it).
//   2. Transforming a simple ESM source produces valid CJS whose eval
//      populates module.exports the same way the policy's runSync
//      patch does (exports.X = ... assignments).
//
// This proves the host wiring + the runSync patch's eval shape work
// in concert without needing a real require(esm) cache miss.

const t = globalThis.__edgeEsmSucraseTransform;
if (typeof t !== 'function') {
  throw new Error('__edgeEsmSucraseTransform not installed');
}

const esmSrc = 'export const x = 42;\nexport const greet = (n) => "hi " + n;\n';
const cjs = t(esmSrc);

// Mirror the policy's eval-as-CJS construction in runSync.
const mod = { exports: {} };
const fn = new Function('require', 'module', 'exports', cjs);
fn(require, mod, mod.exports);

console.log('x:', mod.exports.x);
console.log('greet:', mod.exports.greet('world'));
console.log('__esModule:', mod.exports.__esModule === true);
