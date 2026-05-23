// queueMicrotask() and Promise.resolve().then() share the same
// microtask queue and drain FIFO.  This is observable: a queueMicrotask
// scheduled BEFORE a Promise.then runs first; AFTER, runs after.
//
// Edge's current routing sends `queueMicrotask` through the host's
// queueMicrotask (per Phase B rebuild — NOTES.md
// `task-queue-fallback-recursion`).  Promise.then routes through
// edge's lib promise machinery.  If the two queues diverge, FIFO
// ordering between them breaks.
const order = [];
queueMicrotask(() => order.push('qm1'));
Promise.resolve().then(() => order.push('p1'));
queueMicrotask(() => order.push('qm2'));
Promise.resolve().then(() => order.push('p2'));
setTimeout(() => {
  console.log(order.join(','));
  process.exit(0);
}, 0);
