const http = require('http');

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8080);

const server = http.createServer((req, res) => {
  const chunks = [];

  req.on('data', (chunk) => {
    chunks.push(chunk);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const payload = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body,
    };

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(`${JSON.stringify(payload)}\n`);
  });
});

server.listen(port, host, () => {
  console.log(`echo server listening on http://${host}:${port}`);
});
