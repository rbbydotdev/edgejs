// Verifies the size-threshold fallback in
// crypto-hash-via-host-worker.ts: inputs larger than the threshold
// (default 1 MiB) transparently route through bundled OpenSSL via the
// captured origCreateHash, sidestepping the host-worker staging cap.
//
// A 2 MiB buffer of 'x' is the canonical large-input case (multi-MB
// file checksums).  Before this fix, this throws "data too large for
// digest staging region"; after, the caller sees the correct hash and
// doesn't know which path produced it.
//
// Expected hash captured via host Node:
//   node --eval "console.log(require('crypto').createHash('sha256')
//     .update(Buffer.alloc(2*1024*1024,'x')).digest('hex'))"
//
// The runner invokes this with --policies including
// crypto-hash-via-host-worker.
const c = require('crypto');
const big = Buffer.alloc(2 * 1024 * 1024, 'x'); // 2 MiB
const expected = '6932fd31e5daf4739b9fa78ff777b2831b0995cc1d0b0093cac80601902013bc';
const got = c.createHash('sha256').update(big).digest('hex');
if (got === expected) {
  console.log('crypto-hash-large-fallback-ok');
} else {
  console.log('crypto-hash-large-fallback-bad: got=' + got + ' expected=' + expected);
}
