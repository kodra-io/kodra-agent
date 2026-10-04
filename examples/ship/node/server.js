import { createServer } from 'node:http';

const port = Number(process.env.PORT || 3000);

createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Hello from the Node.js sample');
}).listen(port, () => {
  console.log(`listening on ${port}`);
});
