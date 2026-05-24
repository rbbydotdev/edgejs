// E15: verifies bundled wasm zlib.gzip() works WITHOUT
// compression-via-compressionstream policy.  This was crashing with
// ERR_INTERNAL_ASSERTION: have should not go down — see
// experiments/e13-zlib-crash-debug/FINDINGS.md for root-cause analysis.
//
// The fix lives in browser-target/src/napi-host (overriding
// napi_create_typedarray to wrap small JS-heap typed arrays so they
// are wasm-backed when handed to the C++ binding).
const zlib = require('zlib');

const input = 'hello world';

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
      console.log('gzip-bundled-ok');
    } else {
      console.log('gzip-bundled-bad');
    }
    process.exit(0);
  });
});
