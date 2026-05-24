// E21: verifies the crypto-hmac-via-host-worker policy routes
// crypto.createHmac(algo, key).update(...).digest() through the host's
// SubtleCrypto.importKey + SubtleCrypto.sign({name:'HMAC'}) via the
// worker + sync-RPC channel.  Compares against known-good vectors
// computed via Node's bundled OpenSSL (bit-exact match).
//
// The runner invokes this with --policies including
// crypto-hmac-via-host-worker.
const c = require('crypto');

// Vectors computed via `node -e "console.log(require('crypto').createHmac(...))"`.
const expectedHello256 = '9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b';
const expectedHello1   = 'b34ceac4516ff23a143e61d79d0fa7a4fbe5f266';
const expectedHello384 = 'eacbad575c301fa68afb26dae48b25bf5cd42fd08ed28c08c274ce62df7928f01249976cd8aaf1ab0681d3accedc9543';
const expectedHello512 = 'ff06ab36757777815c008d32c8e14a705b4e7bf310351a06a23b612dc4c7433e7757d20525a5593b71020ea2ee162d2311b247e9855862b270122419652c0c92';
const expectedKeyBuf256 = 'c8cf2a54f0f8275d87651d19c359bb6dfa50a6e89e8f6f110d3b02a9c054d064';
const expectedBase64 = 'kwezuRXvtRcf8U2MtV+8x5jGwO8UVtZt7RpqpyOli3s=';

// Basic sha256, string key, string data.
const hex = c.createHmac('sha256', 'key').update('hello').digest('hex');

// sha1, sha384, sha512 — separate WebCrypto code paths.
const sha1hex = c.createHmac('sha1', 'key').update('hello').digest('hex');
const sha384hex = c.createHmac('sha384', 'key').update('hello').digest('hex');
const sha512hex = c.createHmac('sha512', 'key').update('hello').digest('hex');

// Buffer key — the "Buffer-key" code path through keyToHeapU8.
const keyBufHex = c.createHmac('sha256', Buffer.from('binkey')).update('hello').digest('hex');

// Multi-update streaming surface — chunks must accumulate.
const chunked = c.createHmac('sha256', 'key').update('he').update('llo').digest('hex');

// digest() with no encoding returns a Buffer.
const buf = c.createHmac('sha256', 'key').update('hello').digest();
const bufOk = Buffer.isBuffer(buf) && buf.length === 32 && buf.toString('hex') === expectedHello256;

// digest('base64') — encoding code path.
const b64 = c.createHmac('sha256', 'key').update('hello').digest('base64');

const ok = (
  hex === expectedHello256 &&
  sha1hex === expectedHello1 &&
  sha384hex === expectedHello384 &&
  sha512hex === expectedHello512 &&
  keyBufHex === expectedKeyBuf256 &&
  chunked === expectedHello256 &&
  bufOk &&
  b64 === expectedBase64
);
if (ok) {
  console.log('crypto-hmac-via-host-worker-ok');
} else {
  console.log('crypto-hmac-via-host-worker-bad: hex=' + hex +
    ' sha1=' + sha1hex + ' sha384=' + sha384hex + ' sha512=' + sha512hex +
    ' keybuf=' + keyBufHex + ' chunked=' + chunked + ' bufOk=' + bufOk +
    ' b64=' + b64);
}
