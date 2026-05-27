// Verifies v8.serialize / v8.deserialize preserves Map, Set, Date,
// BigInt, ArrayBuffer, TypedArray, RegExp, nested objects, and back-
// references (cycles). Pre-fix the serdes stub was JSON-backed and
// dropped type fidelity for everything but the JSON subset.
const v8 = require('v8');

// Build a value with every supported type + a cycle.
const inner = new Map([['k', 'v']]);
const obj = {
  map: new Map([['foo', 1], ['bar', 'baz']]),
  set: new Set(['x', 'y', 'z']),
  date: new Date('2026-01-15T12:00:00Z'),
  bignum: 123456789012345678901234567890n,
  negbig: -42n,
  bytes: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
  buf32: new Float32Array([1.5, 2.5, 3.5]),
  ab: new ArrayBuffer(4),
  regex: /foo(bar)+/gi,
  nested: { inner },
  list: [1, 'two', true, null, undefined],
};
// Cycle: list[5] points back to obj.
obj.list.push(obj);

const bytes = v8.serialize(obj);
const back = v8.deserialize(bytes);

console.log('map:', back.map instanceof Map, 'size=' + back.map.size, 'foo=' + back.map.get('foo'));
console.log('set:', back.set instanceof Set, 'size=' + back.set.size, 'has-x=' + back.set.has('x'));
console.log('date:', back.date instanceof Date, back.date.toISOString());
console.log('bigint:', typeof back.bignum === 'bigint', String(back.bignum));
console.log('negbig:', typeof back.negbig === 'bigint', String(back.negbig));
console.log('u8:', back.bytes instanceof Uint8Array, 'len=' + back.bytes.length, 'first=' + back.bytes[0]);
console.log('f32:', back.buf32 instanceof Float32Array, 'len=' + back.buf32.length, 'v0=' + back.buf32[0]);
console.log('ab:', back.ab instanceof ArrayBuffer, 'len=' + back.ab.byteLength);
console.log('regex:', back.regex instanceof RegExp, 'source=' + back.regex.source, 'flags=' + back.regex.flags);
console.log('nested map:', back.nested.inner instanceof Map, 'k=' + back.nested.inner.get('k'));
console.log('cycle:', back.list[5] === back);
process.exit(0);
