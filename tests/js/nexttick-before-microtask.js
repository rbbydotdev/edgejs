// Node-specific ordering: process.nextTick callbacks drain BEFORE
// Promise microtasks within the same tick.  Many Node libs (notably
// streams) depend on this.  Lever B routes microtasks through the
// JS-host worker; if nextTick continues to go through edge's tickInfo
// while microtasks go elsewhere, this ordering breaks (see NOTES.md
// "process.nextTick ordering inversion").
const order = [];
Promise.resolve().then(() => { order.push('microtask'); });
process.nextTick(() => { order.push('nexttick'); });
setTimeout(() => {
  console.log(order.join(','));
  process.exit(0);
}, 0);
