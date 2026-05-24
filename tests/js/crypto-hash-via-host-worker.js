// E18: verifies the crypto-hash-via-host-worker policy routes
// crypto.createHash(...).digest() through the host's SubtleCrypto via
// the worker + sync-RPC channel.  Compares against the known-good
// SHA-256 of "hello" (bit-exact match with bundled OpenSSL).
//
// The runner invokes this with --policies including
// crypto-hash-via-host-worker.
const c = require('crypto');

const expectedHello256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const expectedEmpty256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const expectedHello1   = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';

const hex = c.createHash('sha256').update('hello').digest('hex');
const empty = c.createHash('sha256').digest('hex');
const sha1 = c.createHash('sha1').update('hello').digest('hex');

// Multi-update streaming surface — chunks must accumulate.
const chunked = c.createHash('sha256').update('he').update('llo').digest('hex');

// digest() with no encoding returns a Buffer.
const buf = c.createHash('sha256').update('hello').digest();
const bufOk = Buffer.isBuffer(buf) && buf.length === 32 && buf.toString('hex') === expectedHello256;

// SHA-384 — separate WebCrypto code path.
const sha384hex = c.createHash('sha384').update('hello').digest('hex');
const expectedHello384 = '59e1748777448c69de6b800d7a33bbfb9ff1b463e44354c3553bcdb9c666fa90125a3c79f90397bdf5f6a13de828684f';

const ok = (
  hex === expectedHello256 &&
  empty === expectedEmpty256 &&
  sha1 === expectedHello1 &&
  chunked === expectedHello256 &&
  bufOk &&
  sha384hex === expectedHello384
);
if (ok) {
  console.log('crypto-hash-via-host-worker-ok');
} else {
  console.log('crypto-hash-via-host-worker-bad: hex=' + hex + ' empty=' + empty + ' sha1=' + sha1 + ' chunked=' + chunked + ' bufOk=' + bufOk + ' sha384=' + sha384hex);
}
