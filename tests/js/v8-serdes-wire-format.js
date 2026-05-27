// Verifies v8.serialize() produces V8-wire-format bytes byte-for-byte
// matching what Node.js itself would emit. Crucial for build tools
// (webpack persistent cache, swc cache, jest transform cache) that
// write V8-serialized .pack files and need cross-runtime portability.
//
// Reference: deps/v8/src/objects/value-serializer.cc -- the
// SerializationTag enum (lines 117-235) gives the canonical byte
// values. Each assertion below names the tag bytes inline.
const v8 = require('v8');

function hex(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(buf[i].toString(16).padStart(2, '0'));
  return out.join(' ');
}
function expect(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'ok' : 'FAIL') + ' ' + label + (ok ? '' : ' -- got=' + actual + ' want=' + expected));
}

// Header: 0xFF (kVersion) + varint(15) = 0xFF 0x0F
{
  const ser = new v8.DefaultSerializer();
  ser.writeHeader();
  expect('header', hex(ser.releaseBuffer()), 'ff 0f');
}

// Int32 42: 'I' (0x49) + zigzag-varint(42) = zigzag(42)=84 → 0x54
{
  const buf = v8.serialize(42);
  expect('int32-42', hex(buf), 'ff 0f 49 54');
}

// Int32 -1: 'I' + zigzag-varint(-1)=1 → 0x01
{
  const buf = v8.serialize(-1);
  expect('int32-neg1', hex(buf), 'ff 0f 49 01');
}

// Double 1.5: 'N' (0x4e) + 8 LE bytes (1.5 = 0x3FF8000000000000)
{
  const buf = v8.serialize(1.5);
  expect('double-1.5', hex(buf), 'ff 0f 4e 00 00 00 00 00 00 f8 3f');
}

// true/false: 'T' (0x54) / 'F' (0x46)
{
  expect('true', hex(v8.serialize(true)), 'ff 0f 54');
  expect('false', hex(v8.serialize(false)), 'ff 0f 46');
}

// null/undefined: '0' (0x30) / '_' (0x5f)
{
  expect('null', hex(v8.serialize(null)), 'ff 0f 30');
  expect('undefined', hex(v8.serialize(undefined)), 'ff 0f 5f');
}

// OneByte string "hi": '"' (0x22) + varint(2) + 0x68 0x69
{
  expect('str-hi', hex(v8.serialize('hi')), 'ff 0f 22 02 68 69');
}

// Empty plain object: 'o' (0x6f) + '{' (0x7b) + varint(0)
{
  expect('obj-empty', hex(v8.serialize({})), 'ff 0f 6f 7b 00');
}

// Empty array: 'A' (0x41) + varint(0) + '$' (0x24) + varint(0) + varint(0)
{
  expect('arr-empty', hex(v8.serialize([])), 'ff 0f 41 00 24 00 00');
}

// Empty Map: ';' (0x3b) + ':' (0x3a) + varint(0)
{
  expect('map-empty', hex(v8.serialize(new Map())), 'ff 0f 3b 3a 00');
}

// Empty Set: "'" (0x27) + ',' (0x2c) + varint(0)
{
  expect('set-empty', hex(v8.serialize(new Set())), 'ff 0f 27 2c 00');
}

// Date(0): 'D' (0x44) + 8-byte LE double(0)
{
  expect('date-0', hex(v8.serialize(new Date(0))), 'ff 0f 44 00 00 00 00 00 00 00 00');
}

// Round-trip Map+Set+Date+BigInt
{
  const obj = {
    m: new Map([['k', 1]]),
    s: new Set([1, 2]),
    d: new Date('2026-05-28T00:00:00Z'),
    b: 42n,
  };
  const buf = v8.serialize(obj);
  const back = v8.deserialize(buf);
  expect('roundtrip-map', back.m instanceof Map && back.m.get('k') === 1, true);
  expect('roundtrip-set', back.s instanceof Set && back.s.has(1) && back.s.has(2), true);
  expect('roundtrip-date', back.d instanceof Date && back.d.getTime() === obj.d.getTime(), true);
  expect('roundtrip-bigint', back.b === 42n, true);
}

// Round-trip TypedArray (Uint8Array of [0xDE, 0xAD, 0xBE, 0xEF])
{
  const ta = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
  const back = v8.deserialize(v8.serialize(ta));
  expect('roundtrip-u8-class', back instanceof Uint8Array, true);
  expect('roundtrip-u8-bytes',
    back[0] === 0xDE && back[1] === 0xAD && back[2] === 0xBE && back[3] === 0xEF, true);
}

// Round-trip cycle
{
  const a = { name: 'a' };
  a.self = a;
  const back = v8.deserialize(v8.serialize(a));
  expect('cycle-self', back.self === back, true);
}

process.exit(0);
