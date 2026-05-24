// E11: verify deflate/inflate (and deflateRaw/inflateRaw) via the policy.
const zlib = require('zlib');

const input = Buffer.from('the quick brown fox jumps over the lazy dog');

function rt(comp, decomp, label, next) {
  zlib[comp](input, function (err, c) {
    if (err) { console.log(label + '-err:' + err.message); process.exit(1); return; }
    zlib[decomp](c, function (err2, p) {
      if (err2) { console.log(label + '-derr:' + err2.message); process.exit(1); return; }
      if (Buffer.compare(p, input) === 0) console.log(label + '-ok');
      else console.log(label + '-bad');
      next();
    });
  });
}

rt('deflate', 'inflate', 'deflate', function () {
  rt('deflateRaw', 'inflateRaw', 'deflateRaw', function () {
    process.exit(0);
  });
});
