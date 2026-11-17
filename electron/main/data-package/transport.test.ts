import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDataPackageTransport, createDataPackageHttp, DataPackageHttpError } from './http';

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write('x'.repeat(16 * 1024));
      res.end();
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      // never end: forces the client's timeout to abort
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-dp-budget': 'reads=0/0;writes=0/0;profile=worker-free;pageRows=48;pageBytes=98304' });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('data-package http: real node transport', () => {
  it('performs a real GET and parses the response and budget header', async () => {
    const http = createDataPackageHttp({ request: createNodeDataPackageTransport(), redact: (s) => s });
    const res = await http.request({ url: `${origin}/jobs`, method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, url: '/jobs' });
    expect(res.budget?.pageRows).toBe(48);
  });

  it('stops a streaming response over the byte cap', async () => {
    const http = createDataPackageHttp({ request: createNodeDataPackageTransport(), redact: (s) => s });
    await expect(http.request({ url: `${origin}/big`, method: 'GET', maxBytes: 128 })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('aborts a stalled response and reports timeout', async () => {
    const http = createDataPackageHttp({ request: createNodeDataPackageTransport(), redact: (s) => s });
    await expect(http.request({ url: `${origin}/slow`, method: 'GET', timeoutMs: 50 })).rejects.toBeInstanceOf(DataPackageHttpError);
  });
});
