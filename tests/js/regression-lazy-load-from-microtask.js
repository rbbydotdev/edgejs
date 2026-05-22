// Regression for `lazy-load-from-microtask` (NOTES.md).
//
// Symptom: when console.log is first invoked from inside a microtask
// continuation, lib's lazy-loaded paths (internal/util/colors,
// internal/util/inspect) returned non-function from compileForInternalLoader.
// Visible as `TypeError: fn is not a function` from realm.js:401.
//
// This test invokes console.log multi-arg (forces lazyUtilColors +
// lazyInspect) from inside a Promise.then continuation — the bug's natural
// habitat — without any pre-priming prelude.
Promise.resolve().then(() => {
  console.log('a', 'b');
});
