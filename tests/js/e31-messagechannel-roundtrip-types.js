console.log('A:start');
const wt = require('worker_threads');
const ch = new wt.MessageChannel();

const tests = [
  ['string', 'hello'],
  ['number', 42],
  ['boolean', true],
  ['null', null],
  ['undefined', undefined],
  ['object', { a: 1, b: 'x' }],
  ['array', [1, 2, 3]],
];

let idx = 0;
ch.port2.on('message', (data) => {
  const [label, sent] = tests[idx];
  const got = JSON.stringify(data === undefined ? 'UNDEFINED' : data);
  const expected = JSON.stringify(sent === undefined ? 'UNDEFINED' : sent);
  console.log(`R[${idx}]:${label} sent=${expected} got=${got} match=${got === expected}`);
  idx++;
  if (idx < tests.length) {
    ch.port1.postMessage(tests[idx][1]);
  } else {
    console.log('DONE');
    ch.port1.close();
    ch.port2.close();
    process.exit(0);
  }
});

ch.port1.postMessage(tests[0][1]);

setTimeout(() => {
  console.log('TIMEOUT idx=' + idx);
  process.exit(2);
}, 5000);
