const order = [];
setTimeout(() => {
  order.push('timer1');
  queueMicrotask(() => order.push('microtask'));
}, 0);
setTimeout(() => {
  order.push('timer2');
  console.log(order.join(','));
  process.exit(0);
}, 0);
