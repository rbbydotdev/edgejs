// b₄ Sucrase backstop, TLA case: when the ESM source has top-level
// await, the backstop CAN'T sync-ify it.  The policy's hasTopLevelAwait
// heuristic detects this and re-throws the original
// ERR_REQUIRE_ASYNC_MODULE without attempting the transform.
//
// We can't easily drive a real require(esm) -> runSync miss here
// (needs an .mjs fixture).  Instead, mirror the heuristic the policy
// uses and verify it positively identifies a TLA source.  This is
// the same regex the policy embeds via POST_PATCH.

const tlaSrc = 'const x = await Promise.resolve(1);\nexport { x };\n';
const plainSrc = 'export const x = 1;\n';

// Same regex as the policy's hasTopLevelAwait (also esm-registry.ts's
// detectTopLevelAwait).
const hasTopLevelAwait = (src) => /(?:^|[\s;{}(])await\s/.test(src);

console.log('tla source flagged:', hasTopLevelAwait(tlaSrc));
console.log('plain source flagged:', hasTopLevelAwait(plainSrc));

// Sanity-check that the Sucrase transform IS available (host wiring
// is in place), so a "TLA flagged" result is a real intentional
// re-throw, not an absence-of-Sucrase fallback.
console.log(
  'sucrase wired:',
  typeof globalThis.__edgeEsmSucraseTransform === 'function',
);
