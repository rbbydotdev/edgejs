const http = require('http');

const port = Number(process.env.PORT || 3000);

function parseBody(rawBody, contentType) {
  if (!rawBody) {
    return {};
  }

  if (contentType && contentType.toLowerCase().includes('application/json')) {
    return JSON.parse(rawBody);
  }

  return { raw: rawBody };
}

const server = http.createServer((req, res) => {
  const chunks = [];

  req.on('data', (chunk) => {
    chunks.push(chunk);
  });

  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body;

    try {
      body = parseBody(rawBody, req.headers['content-type']);
    } catch (error) {
      res.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({
        error: 'invalid JSON request body',
        message: error.message,
      }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body,
    }));
  });
});

server.listen(port, () => {
  console.log(`echo server listening on port ${port}`);
});
