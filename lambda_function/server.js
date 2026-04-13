'use strict';

const http = require('node:http');

const { handler } = require('./intake-handler');

const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/validate-license') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route not found' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const event = {
        body: Buffer.concat(chunks).toString('utf8')
      };

      const response = await handler(event);

      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unexpected server error', details: error.message }));
    }
  });
});

server.listen(port, () => {
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  console.log(`Driver license screening server listening on port ${boundPort}`);
});
