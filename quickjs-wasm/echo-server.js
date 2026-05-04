const http = require('http');

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`quickjs edge echo: ${req.method} ${req.url}\n`);
});

server.listen(port, () => {
  console.log(`quickjs edge echo listening on ${port}`);
});
