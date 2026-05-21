// Verifies the outbound-fetch-tunnel policy: http.request/https.request
// re-implemented on top of globalThis.fetch.
//
// The runner invokes this with `--policies buffer-pool-disable,outbound-fetch-tunnel`.
//
// Mock strategy: stub `globalThis.fetch` to return a Response-shape object
// whose `arrayBuffer()` resolves to a regular Uint8Array.buffer (NOT
// edge's `new Response(...)`, which currently has a SharedArrayBuffer/
// ArrayBuffer compat bug — see NOTES.md "SAB/AB body read" debt).  This
// isolates the tunnel wiring from that lower-layer issue.
//
// NOTE: no setTimeout watchdog here.  See NOTES.md
// microtasks-starved-by-pending-timer debt: edge's wasm event loop holds
// microtasks until a pending timer fires, which would defer the fetch
// response past any watchdog and make the test always look like a timeout.
// If the fetch never resolves we'd hang the harness; the test-runner has
// its own 30s subprocess timeout that catches genuine hangs.

let calls = 0;
globalThis.fetch = async (url, init) => {
  calls++;
  const bodyStr = init && init.body
    ? (typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8'))
    : '';
  const respJson = JSON.stringify({ url, method: init && init.method, gotBody: bodyStr });
  const respBytes = new Uint8Array(Buffer.from(respJson, 'utf8'));
  return {
    status: 200,
    statusText: 'OK',
    headers: new Map([
      ['content-type', 'application/json'],
      ['x-test', '1'],
    ]),
    arrayBuffer: async () => respBytes.buffer.slice(respBytes.byteOffset, respBytes.byteOffset + respBytes.byteLength),
    text: async () => respJson,
  };
};

const http = require('http');

const req = http.request({
  hostname: 'example.com',
  path: '/api/echo',
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
}, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    const parsed = JSON.parse(body);
    const ok = (
      res.statusCode === 200 &&
      res.headers['x-test'] === '1' &&
      parsed.url === 'http://example.com/api/echo' &&
      parsed.method === 'POST' &&
      parsed.gotBody === 'payload-here' &&
      calls === 1
    );
    console.log(ok ? 'fetch-tunnel-ok' : 'fetch-tunnel-bad: status=' + res.statusCode + ' body=' + body);
    process.exit(0);
  });
});

req.write('payload-here');
req.end();
