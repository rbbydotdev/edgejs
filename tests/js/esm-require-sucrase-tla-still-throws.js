// b₄ Sucrase backstop, TLA case: when the ESM source has top-level
// await, the backstop CAN'T sync-ify it.  The policy now uses
// compile-time detection — Sucrase transforms ESM to CJS-shaped
// syntax but leaves top-level await as-is; the subsequent
// `new Function(...)` then throws SyntaxError at compile time,
// because Function bodies are synchronous.  The catch block
// inspects the SyntaxError message; if it mentions 'await', the
// policy re-throws the original ERR_REQUIRE_ASYNC_MODULE.
//
// We exercise the contract end-to-end without an .mjs fixture by
// driving both ends of the compile chain directly: the Sucrase
// transform output for a TLA source, then `new Function(...)` on
// it, asserting the expected SyntaxError mentions await.

const t = globalThis.__edgeEsmSucraseTransform;
if (typeof t !== 'function') throw new Error('sucrase transform not wired');

const tlaSrc = 'const x = await Promise.resolve(1);\nexport { x };\n';
const plainSrc = 'export const x = 1;\n';

// 1. Plain source: transform + new Function compiles cleanly.
let plainCompiled = false;
try {
  const cjs = t(plainSrc);
  new Function('require', 'module', 'exports', cjs);
  plainCompiled = true;
} catch (e) { void e; }
console.log('plain compiles:', plainCompiled);

// 2. TLA source: transform + new Function throws SyntaxError
//    mentioning await.  This is the signal the policy uses to
//    re-throw ERR_REQUIRE_ASYNC_MODULE.
let tlaError = null;
try {
  const cjs = t(tlaSrc);
  new Function('require', 'module', 'exports', cjs);
} catch (e) {
  tlaError = e;
}
console.log('tla throws:', tlaError !== null);
console.log('mentions await:', tlaError && /await/i.test(tlaError.message || ''));
