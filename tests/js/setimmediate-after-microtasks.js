// setImmediate runs in the check phase of libuv, AFTER all pending
// microtasks have drained at the boundary of the previous phase.
// Schedule a microtask + setImmediate + setTimeout(0) and observe:
//   microtask runs first (queued in current sync code)
//   then either timer or immediate (libuv-order-dependent)
//
// This test only asserts microtask-runs-first.  If immediate/timer
// ordering between themselves is what you want to test, use an
// upstream drop-in (test-timers-ordering.js).
const order = [];
Promise.resolve().then(() => order.push('microtask'));
setImmediate(() => {
  order.push('immediate');
  // 'microtask' must already be in order before 'immediate' fires.
  console.log(order[0] === 'microtask' ? 'ok' : 'FAIL:' + order.join(','));
  process.exit(0);
});
