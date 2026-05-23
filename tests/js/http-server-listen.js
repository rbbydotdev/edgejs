// http.createServer + listen smoke.  Sibling of https-server-listen
// but without TLS — exercises the plain http stack which doesn't go
// through edge.js's secure_context / OpenSSL paths.  Like the HTTPS
// version, this only verifies that the listening callback fires; an
// actual request roundtrip needs the SW bridge transport.
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('hi');
});

server.listen(0, '127.0.0.1', () => {
  console.log('http-listen-ok');
  process.exit(0);
});

setTimeout(() => { console.log('http-listen-timeout'); process.exit(1); }, 5000);
