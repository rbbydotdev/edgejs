// E22-C: verifies the crypto-hmac-via-host-worker policy handles
// combined (key + data) inputs larger than a single RPC slot via the
// shared-memory data channel (OP_SUBTLE_HMAC_VIA_NAPI_MEM).  Before
// E22-C these calls threw at the E21 slot-overflow guard with a
// "data too large for single RPC slot" error pointing the caller back
// to bundled OpenSSL.
//
// Coverage:
//   - 5000 B data with a short key: first size above the old ~4055 B
//     small-slot cap; small key keeps total dominated by data.
//   - 32 KiB key + 32 KiB data SHA-256: balanced moderate large case.
//   - 64 KiB key + 64 KiB data: SHA-256, SHA-1, SHA-384, SHA-512 —
//     per-algorithm sanity at full staging-region capacity.
//   - Multi-update chunking of a 64 KiB data: confirms the policy's
//     chunk accumulator still works on the large path.
//   - A short HMAC after the large ones — confirms small path still
//     works once the napi staging region has been touched.
//
// Each expected hex was generated with Node 22's crypto on the same
// byte pattern `byte i = i & 0xff`.
const c = require('crypto');

function fill(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
}

const k32  = fill(32 * 1024);
const d32  = fill(32 * 1024);
const k64  = fill(64 * 1024);
const d64  = fill(64 * 1024);
const d5k  = fill(5000);

const expected = {
  hmac256_smallkey_d5k: 'b080b1e7ee72c639473bab3122d5d399d9a00c246775a8c6da5371248f77b403',
  hmac256_k32k_d32k:    '335a55680650aae2a4e53fe3c70628a38f3790a685243e942b4e869e022c243d',
  hmac256_k64k_d64k:    '596a4cb2c63910bd2375bae3a997b1792d7b051cf93bfe40adc71eeea28b02b6',
  hmac1_k64k_d64k:      '140e5c25227bc62c39763dd11dee5e0cbe54cd67',
  hmac384_k64k_d64k:    '6c72acf224920186ee42b7143e8cf46c27312312ffc35a0cbc2bfc4224870b0084eda3fee3a5d3fda96aec4b4eb77ec7',
  hmac512_k64k_d64k:    '531df2d10b357a5a46b68757c8dcebb3b75883679128879af7e53dfc214932b2daff24729016e00fa19e5a18cbdeff6499afa32e597d0730759cdf61ded88f5c',
  hmac256_hello:        '9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b',
};

const got = {
  hmac256_smallkey_d5k: c.createHmac('sha256', 'key').update(d5k).digest('hex'),
  hmac256_k32k_d32k:    c.createHmac('sha256', k32).update(d32).digest('hex'),
  hmac256_k64k_d64k:    c.createHmac('sha256', k64).update(d64).digest('hex'),
  hmac1_k64k_d64k:      c.createHmac('sha1',   k64).update(d64).digest('hex'),
  hmac384_k64k_d64k:    c.createHmac('sha384', k64).update(d64).digest('hex'),
  hmac512_k64k_d64k:    c.createHmac('sha512', k64).update(d64).digest('hex'),
  // small-input fast path still works after large-path activations
  hmac256_hello:        c.createHmac('sha256', 'key').update('hello').digest('hex'),
};

// Multi-update on the large path: split a 64K buffer into 4 pieces.
// The policy buffers chunks in JS-heap and concatenates at digest()
// time; confirm the large transport reads the concatenated bytes.
const h = c.createHmac('sha256', k64);
h.update(d64.slice(0, 16 * 1024));
h.update(d64.slice(16 * 1024, 32 * 1024));
h.update(d64.slice(32 * 1024, 48 * 1024));
h.update(d64.slice(48 * 1024));
const chunked64k = h.digest('hex');

const failures = [];
for (const k of Object.keys(expected)) {
  if (got[k] !== expected[k]) failures.push(`${k}: got=${got[k]} expected=${expected[k]}`);
}
if (chunked64k !== expected.hmac256_k64k_d64k) {
  failures.push(`chunked64k: got=${chunked64k} expected=${expected.hmac256_k64k_d64k}`);
}

if (failures.length === 0) {
  console.log('crypto-hmac-via-host-worker-large-ok');
} else {
  console.log('crypto-hmac-via-host-worker-large-bad: ' + failures.join(' | '));
}
