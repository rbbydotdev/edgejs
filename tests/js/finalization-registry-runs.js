// FinalizationRegistry callbacks fire after a GC observes an unreferenced
// target.  In real Node, ClearKeptObjects runs as part of the microtask
// checkpoint, so the finalizer callback (itself a microtask-like task)
// gets a chance to run.
//
// NOTES.md flags "WeakRef / FinalizationRegistry leaks: ClearKeptObjects
// never runs (would be a side-effect of proper microtask checkpoint)".
// This test will fail until that's fixed; kept as the smoke for when
// it is.  See companion .skip file.
//
// Note: deterministic GC observation is impossible without --expose-gc
// (which the runner skips).  This test gives the engine a generous
// window and accepts any "fired" output as success.
const reg = new FinalizationRegistry((tag) => {
  console.log('finalized:' + tag);
  process.exit(0);
});
(function () {
  const target = { x: 1 };
  reg.register(target, 'A');
})();
// Allocate to encourage GC pressure.
const blobs = [];
for (let i = 0; i < 1000; i++) blobs.push(new Array(1000).fill(i));
setTimeout(() => {
  console.log('not fired');
  process.exit(1);
}, 200);
