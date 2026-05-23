// A chain of .then() callbacks must ALL drain before any macrotask
// fires.  This stresses recursive microtask checkpoint: each .then()
// enqueues another microtask during draining, and the checkpoint
// must keep draining until empty.
//
// If the wasm event loop yields back to the host after the first
// microtask (instead of looping the checkpoint), the timer would
// fire before the chain completes.
const order = [];
Promise.resolve()
  .then(() => order.push('p1'))
  .then(() => order.push('p2'))
  .then(() => order.push('p3'))
  .then(() => order.push('p4'))
  .then(() => order.push('p5'));
setTimeout(() => {
  order.push('timer');
  console.log(order.join(','));
  process.exit(0);
}, 0);
