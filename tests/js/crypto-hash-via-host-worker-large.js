// E22: verifies the crypto-hash-via-host-worker policy handles inputs
// larger than a single RPC slot via the shared-memory data channel
// (OP_SUBTLE_DIGEST_VIA_NAPI_MEM).  Before E22 these calls threw at the
// E18 slot-overflow guard with a "data too large for single RPC slot"
// error pointing the caller back to bundled OpenSSL.
//
// Coverage:
//   - 5000 B SHA-256: first size above the old ~4055 B small-slot cap.
//   - 64 KiB SHA-256, SHA-1, SHA-384, SHA-512: per-algorithm sanity.
//   - 100 KiB SHA-256: comfortably above 64 KiB.
//   - 128 KiB SHA-256: at the staging-region capacity (sanity).
//   - Multi-update chunking of a 64 KiB input: confirms the policy's
//     chunk accumulator still works on the large path.
//
// Each expected hex was generated with Node 22's crypto on a buffer
// pattern `byte i = i & 0xff` (so identical bytes here and there) —
// bit-exact match against bundled OpenSSL would otherwise be vacuous.
const c = require('crypto');

function fill(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
}

const buf3000 = fill(3000);         // small path
const buf5000 = fill(5000);         // above old slot cap; first large-path size
const buf64k  = fill(64 * 1024);    // canonical large input
const buf100k = fill(100 * 1024);   // bigger than 64K
const buf128k = fill(128 * 1024);   // at staging capacity

const expected = {
  small3000:  '8238f003ad1a7f56965542e097622333a1e90eb52301496c34fe39ab34c2e9e6',
  large5000:  '8026e5c96cf1e502c8deb3e89f8b8bc342f5039b871911a92eb10edf9c6542d3',
  large64k:   '7daca2095d0438260fa849183dfc67faa459fdf4936e1bc91eec6b281b27e4c2',
  sha1_64k:   'f04977267a391b2c8f7ad8e070f149bc19b0fc25',
  sha384_64k: '250709c010f8b4554564bc9a26da8cde3470e946d3af85ee7c6f672e4de023725881dd1a816ea377dbfdea65d7fb182a',
  sha512_64k: '76a59ba2dd234dfb4136e2e33a7e3b344d82f4885a17e3b297eab9a5ded81043292217b8126b1cfba29170dce2780259dc68ab4f382efe91aa4bb404912741f4',
  large100k:  '27783e87963a4efb6829b531c9ba57b44f45797f6770bd637fbf0d807cbdbae0',
  large128k:  '59f410ae5e17962412e2aed4f815918f634932f2abf084f00bb638c4db017850',
};

const got = {
  small3000:  c.createHash('sha256').update(buf3000).digest('hex'),
  large5000:  c.createHash('sha256').update(buf5000).digest('hex'),
  large64k:   c.createHash('sha256').update(buf64k).digest('hex'),
  sha1_64k:   c.createHash('sha1').update(buf64k).digest('hex'),
  sha384_64k: c.createHash('sha384').update(buf64k).digest('hex'),
  sha512_64k: c.createHash('sha512').update(buf64k).digest('hex'),
  large100k:  c.createHash('sha256').update(buf100k).digest('hex'),
  large128k:  c.createHash('sha256').update(buf128k).digest('hex'),
};

// Multi-update on the large path: split a 64K buffer into 4 pieces.
// The policy buffers chunks in JS-heap then concatenates at digest()
// time; we want to confirm the large transport reads the concatenated
// bytes correctly.
const h = c.createHash('sha256');
h.update(buf64k.slice(0, 16 * 1024));
h.update(buf64k.slice(16 * 1024, 32 * 1024));
h.update(buf64k.slice(32 * 1024, 48 * 1024));
h.update(buf64k.slice(48 * 1024));
const chunked64k = h.digest('hex');

const failures = [];
for (const k of Object.keys(expected)) {
  if (got[k] !== expected[k]) failures.push(`${k}: got=${got[k]} expected=${expected[k]}`);
}
if (chunked64k !== expected.large64k) {
  failures.push(`chunked64k: got=${chunked64k} expected=${expected.large64k}`);
}

if (failures.length === 0) {
  console.log('crypto-hash-via-host-worker-large-ok');
} else {
  console.log('crypto-hash-via-host-worker-large-bad: ' + failures.join(' | '));
}
