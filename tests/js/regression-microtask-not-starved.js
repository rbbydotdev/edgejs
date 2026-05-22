// Regression for `microtasks-starved-by-pending-timer` (NOTES.md).
//
// Symptom: when a setTimeout was pending, edge's wasm event loop blocked
// ALL microtasks until SOME timer fired.  In real Node, microtasks always
// drain before timer callbacks — that ordering is load-bearing for many
// libs.
//
// This test schedules a 100ms timer (kept pending), schedules a microtask
// that flips a flag, then schedules a 50ms timer that reads the flag.
// Under Node-correct semantics the microtask flips the flag before either
// timer fires, so the 50ms timer observes `mtRan=true`.  If microtasks
// are starved until the soonest pending timer fires, the 50ms timer
// might observe `mtRan=false`.
let mtRan = false;
setTimeout(() => { /* keep loop alive past 50ms */ }, 100);
Promise.resolve().then(() => { mtRan = true; });
setTimeout(() => {
  console.log('mtRan=' + mtRan);
  process.exit(0);
}, 50);
