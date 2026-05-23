// The continuation after `await` is a microtask.  An `await` of an
// already-resolved Promise should resume BEFORE a setTimeout(0)
// scheduled before the await statement.
//
// This is the standard test for async/await composing correctly with
// microtask semantics.  Real Node passes it trivially; Lever B's
// cross-worker JS-host routing must preserve it.
const order = [];
setTimeout(() => {
  order.push('timer');
  console.log(order.join(','));
  process.exit(0);
}, 0);
(async () => {
  await Promise.resolve();
  order.push('post-await');
})();
