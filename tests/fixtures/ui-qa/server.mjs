import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function createFormServer() {
  const page = readFileSync(new URL('./form.html', import.meta.url));
  return createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (req.url === '/api/books' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ books: ['Азбука'] }));
    }
    if (req.url === '/api/books' && req.method === 'POST') {
      req.resume();
      res.writeHead(201);
      return res.end();
    }
    res.writeHead(req.url === '/favicon.ico' ? 204 : 404);
    res.end();
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = createFormServer();
  server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
}
