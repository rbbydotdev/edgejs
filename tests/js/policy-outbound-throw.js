// Verifies the outbound-throw policy: when applied, http.request,
// http.get, https.request, and https.get all throw ERR_BROWSER_NO_OUTBOUND.
// Server-side createServer is NOT affected (that's owned by inbound-* policies).
//
// The runner invokes this test with `--policies buffer-pool-disable,outbound-throw`.

const http = require('http');
const https = require('https');

let count = 0;
const fns = [
  () => http.request({ host: 'x' }),
  () => http.get({ host: 'x' }),
  () => https.request({ host: 'x' }),
  () => https.get({ host: 'x' }),
];
for (const fn of fns) {
  try { fn(); }
  catch (e) {
    if (e && e.code === 'ERR_BROWSER_NO_OUTBOUND') count++;
  }
}

// http.createServer should still work
let serverOk = false;
try {
  const s = http.createServer(() => {});
  serverOk = typeof s.listen === 'function';
} catch {}

console.log(count === 4 && serverOk ? 'outbound-throw-ok' : `outbound-throw-bad:count=${count},server=${serverOk}`);
