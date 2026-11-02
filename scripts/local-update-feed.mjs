import { createServer } from 'node:http';
import { realpath, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const directory = resolve(process.argv[2] ?? 'release-win');
const port = Number(process.argv[3] ?? '0');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid-port');
const root = await realpath(directory);

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  let requested;
  try { requested = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1)); }
  catch { response.writeHead(400).end(); return; }
  if (!requested || requested.includes('\0')) { response.writeHead(404).end(); return; }
  try {
    const path = await realpath(resolve(root, requested));
    if (path !== root && !path.startsWith(`${root}${sep}`)) { response.writeHead(404).end(); return; }
    const info = await stat(path);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    const body = request.method === 'HEAD' ? undefined : await readFile(path);
    response.writeHead(200, {
      'content-type': extname(path).toLowerCase() === '.yml' || extname(path).toLowerCase() === '.yaml' ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('feed-listen-failed');
  process.stdout.write(`Local Windows update feed: http://127.0.0.1:${address.port}/latest.yml\n`);
});
const close = () => server.close(() => process.exit(0));
process.once('SIGINT', close);
process.once('SIGTERM', close);
