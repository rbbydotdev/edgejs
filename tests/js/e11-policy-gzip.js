// E11: verifies the compression-via-compressionstream policy actually
// works — gzip() async callback fires AND bytes round-trip via gunzip().
const zlib = require('zlib');

const input = 'hello world hello world hello world hello world';

zlib.gzip(input, function (err, gzipped) {
  if (err) {
    console.log('gzip-err:' + err.message);
    process.exit(1);
    return;
  }
  if (!Buffer.isBuffer(gzipped)) {
    console.log('gzip-not-buffer');
    process.exit(1);
    return;
  }
  zlib.gunzip(gzipped, function (err2, plain) {
    if (err2) {
      console.log('gunzip-err:' + err2.message);
      process.exit(1);
      return;
    }
    if (plain.toString('utf8') === input) {
      console.log('gzip-roundtrip-ok');
    } else {
      console.log('gzip-roundtrip-bad');
    }
    process.exit(0);
  });
});
