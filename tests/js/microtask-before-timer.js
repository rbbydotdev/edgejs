// Basic ordering: a queued microtask MUST drain before any timer callback,
// even setTimeout(0).  This is the most fundamental microtask invariant
// Node preserves; Lever B (split-worker topology) and any future microtask
// pump work must keep it intact.
//
// Note: separate from regression-microtask-not-starved.js, which probes
// the harder case (microtasks starved by a LATER-firing pending timer).
// This file probes the simple case as a smoke for the basic invariant.
const order = [];
Promise.resolve().then(() => { order.push('microtask'); });
setTimeout(() => {
  order.push('timer');
  console.log(order.join(','));
  process.exit(0);
}, 0);
