// Verifies serialization:'advanced' + killable:'hard' round-trips Map,
// Set, Date, BigInt, ArrayBuffer, nested structures with full V8
// structured-clone fidelity. Two-hop bridge: wasm-runtime <-> host
// (existing port) <-> runner worker (new per-spawn port). Each hop is
// real structured-clone, so types preserve end-to-end.
const { spawn } = require('child_process');

const child = spawn('clone-echo-killable', [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  serialization: 'advanced',
  killable: 'hard',
});

const results = [];
child.on('message', (msg) => {
  results.push(msg);
  if (msg && msg.bye) {
    const r0 = results[0];
    console.log('map roundtrip:', r0.map instanceof Map, 'size:', r0.map.size,
      'foo:', r0.map.get('foo'));
    console.log('set roundtrip:', r0.set instanceof Set, 'size:', r0.set.size,
      'has-x:', r0.set.has('x'));
    console.log('date roundtrip:', r0.date instanceof Date,
      'iso:', r0.date.toISOString());
    console.log('bigint roundtrip:', typeof r0.bignum === 'bigint',
      'value:', String(r0.bignum));
    console.log('u8 roundtrip:', r0.bytes instanceof Uint8Array,
      'length:', r0.bytes.length, 'first:', r0.bytes[0]);
    console.log('nested map:', r0.nested.inner instanceof Map);
    process.exit(0);
  }
});

const payload = {
  map: new Map([['foo', 1], ['bar', 2]]),
  set: new Set(['x', 'y', 'z']),
  date: new Date('2026-01-15T12:00:00Z'),
  bignum: 123456789012345678901234567890n,
  bytes: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
  nested: { inner: new Map([['k', 'v']]) },
};
child.send(payload);
child.send({ bye: true });
