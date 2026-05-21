// Verifies the crypto-host-random policy routes random APIs to host's
// WebCrypto (crypto.getRandomValues + crypto.randomUUID).
//
// The runner invokes this with --policies including crypto-host-random.

const c = require('crypto');

// randomBytes (sync)
const a = c.randomBytes(16);
const b = c.randomBytes(16);
const randomBytesOk = (
  Buffer.isBuffer(a) &&
  Buffer.isBuffer(b) &&
  a.length === 16 &&
  b.length === 16 &&
  a.toString('hex') !== b.toString('hex')
);

// randomBytes (sync, large — crosses the 65536 WebCrypto fill cap)
const big = c.randomBytes(100000);
const bigOk = Buffer.isBuffer(big) && big.length === 100000;

// randomFillSync
const fillBuf = Buffer.alloc(32);
c.randomFillSync(fillBuf);
const fillSyncOk = !fillBuf.every((byte) => byte === 0);

// randomFillSync with offset+size
const partialBuf = Buffer.alloc(32);
c.randomFillSync(partialBuf, 8, 16);
const partialFillOk = (
  // First 8 bytes untouched (zero)
  partialBuf.slice(0, 8).every((byte) => byte === 0) &&
  // Middle 16 bytes filled (very unlikely all-zero from CSPRNG)
  !partialBuf.slice(8, 24).every((byte) => byte === 0) &&
  // Last 8 bytes untouched
  partialBuf.slice(24, 32).every((byte) => byte === 0)
);

// randomUUID — must match v4 UUID format
const u = c.randomUUID();
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidOk = uuidRe.test(u);

const ok = randomBytesOk && bigOk && fillSyncOk && partialFillOk && uuidOk;
if (ok) {
  console.log('crypto-host-random-ok');
} else {
  console.log('crypto-host-random-bad: bytes=' + randomBytesOk + ' big=' + bigOk + ' fill=' + fillSyncOk + ' partial=' + partialFillOk + ' uuid=' + uuidOk);
}
