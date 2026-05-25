// Verify MessageChannel postMessage roundtrips structured-cloneable types
// the prior JSON-based serializer lost: ArrayBuffer/TypedArray/Map/Set/
// Date/RegExp/nested.  Fixed in e32 by replacing the serialize/deserialize
// trio with browser-native structuredClone.
//
// Known not-yet-supported (deferred to future e3X experiment):
//   - circular refs: C++ side's PrepareTransferableDataForStructuredClone
//     (binding_messaging.cc) has an unguarded recursive walker that hits
//     "Maximum call stack size exceeded" BEFORE our serializer is called.
//     Needs a C++ fix + wasm rebuild.
//   - transferList detach semantics: napi serialize signature has no
//     transferList slot; AB data arrives correctly (copy) but source
//     isn't detached.  Per-spec stricter behavior needs the napi
//     signature extended or a side-channel.
const { MessageChannel } = require('worker_threads');

function check(label, ok) {
  console.log(`${label}:${ok ? 'PASS' : 'FAIL'}`);
}

const ch = new MessageChannel();
let idx = 0;

const ab = new ArrayBuffer(16);
new Uint8Array(ab)[0] = 0xDE;
new Uint8Array(ab)[1] = 0xAD;

const cases = [
  ['ArrayBuffer', ab, (g) => g instanceof ArrayBuffer && new Uint8Array(g)[0] === 0xDE && new Uint8Array(g)[1] === 0xAD],
  ['Uint8Array', new Uint8Array([1, 2, 3, 4, 5]), (g) => g instanceof Uint8Array && g[0] === 1 && g[4] === 5],
  ['Int32Array', new Int32Array([100, 200, -300]), (g) => g instanceof Int32Array && g[0] === 100 && g[2] === -300],
  ['Date', new Date('2026-05-25T12:34:56Z'), (g) => g instanceof Date && g.getTime() === new Date('2026-05-25T12:34:56Z').getTime()],
  ['RegExp', /foo.*bar/gi, (g) => g instanceof RegExp && g.source === 'foo.*bar' && g.flags === 'gi'],
  ['Map', new Map([['k1', 'v1'], ['k2', 42]]), (g) => g instanceof Map && g.get('k1') === 'v1' && g.get('k2') === 42],
  ['Set', new Set([1, 'two', true]), (g) => g instanceof Set && g.has(1) && g.has('two') && g.has(true)],
  ['nested', { a: { b: { c: [1, 2, { deep: 'yes' }] } } }, (g) => g.a.b.c[2].deep === 'yes'],
];

ch.port2.on('message', (got) => {
  const [label, , cmp] = cases[idx];
  check(label, cmp(got));
  idx++;
  if (idx < cases.length) {
    ch.port1.postMessage(cases[idx][1]);
  } else {
    process.exit(0);
  }
});

ch.port1.postMessage(cases[0][1]);

setTimeout(() => {
  console.log('TIMEOUT idx=' + idx);
  process.exit(2);
}, 5000);
