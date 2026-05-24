// E14: verifies the crypto-via-subtle policy routes crypto.pbkdf2 to
// host SubtleCrypto.deriveBits with PBKDF2 and produces the same bytes
// as Node's bundled OpenSSL would (bit-exact PBKDF2 output across
// implementations).
//
// Known-good reference values were captured from host Node:
//   node --eval "console.log(require('crypto').pbkdf2Sync('pwd', 'salt', 100, 16, 'sha256').toString('hex'))"
//   => 397ca5768f332cbc646df76dbec2d689
//
//   node --eval "console.log(require('crypto').pbkdf2Sync('password123', 'somesalt', 1000, 32, 'sha256').toString('hex'))"
//   => f6e19c8932b462c16cf085fae85d981b2c7e17fdb56c15426c74faa531911330
//
// The runner invokes this with --policies including crypto-via-subtle.
const c = require('crypto');

const expected1 = '397ca5768f332cbc646df76dbec2d689';
const expected2 = 'f6e19c8932b462c16cf085fae85d981b2c7e17fdb56c15426c74faa531911330';

c.pbkdf2('pwd', 'salt', 100, 16, 'sha256', function (err, key) {
  if (err) {
    console.log('pbkdf2-err:' + err.message);
    process.exit(1);
    return;
  }
  if (!Buffer.isBuffer(key)) {
    console.log('pbkdf2-not-buffer');
    process.exit(1);
    return;
  }
  if (key.length !== 16) {
    console.log('pbkdf2-bad-length:' + key.length);
    process.exit(1);
    return;
  }
  const hex1 = key.toString('hex');
  if (hex1 !== expected1) {
    console.log('pbkdf2-bad-bytes-1:' + hex1);
    process.exit(1);
    return;
  }

  // Second case verifies a longer key + higher iterations to make sure
  // it isn't just memoized or short-circuited.
  c.pbkdf2('password123', 'somesalt', 1000, 32, 'sha256', function (err2, key2) {
    if (err2) {
      console.log('pbkdf2-err-2:' + err2.message);
      process.exit(1);
      return;
    }
    const hex2 = key2.toString('hex');
    if (hex2 !== expected2) {
      console.log('pbkdf2-bad-bytes-2:' + hex2);
      process.exit(1);
      return;
    }
    console.log('pbkdf2-via-subtle-ok');
    process.exit(0);
  });
});
