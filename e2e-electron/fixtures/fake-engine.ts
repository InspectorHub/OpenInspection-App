import { createServer, type Server } from 'node:http';

export interface FakeEngine {
  url: string;
  server: Server;
  uploads: Map<string, Buffer>;
  uploadCounts: Map<string, number>;
  close(): Promise<void>;
}

/** Small loopback fixture for desktop upload flows; keys make duplicate server objects observable to later E2E tests. */
export async function startFakeEngine(): Promise<FakeEngine> {
  const uploads = new Map<string, Buffer>();
  const uploadCounts = new Map<string, number>();
  const tokens = new Map<string, string>();
  let origin = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin);
    const uploadUrlMatch = /^\/api\/inspections\/([^/]+)\/media\/upload-url$/.exec(url.pathname);
    if (request.method === 'POST' && uploadUrlMatch) {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: { pendingId?: unknown };
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { pendingId?: unknown }; }
        catch { response.writeHead(400).end(); return; }
        if (typeof body.pendingId !== 'string' || body.pendingId.length < 1 || body.pendingId.length > 128) { response.writeHead(400).end(); return; }
        const token = `fake-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        const key = `fake/inspections/${decodeURIComponent(uploadUrlMatch[1]!)}/photos/${body.pendingId}.jpg`;
        tokens.set(token, key);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, data: { url: `${origin}/api/public/uploads/photo?token=${token}`, key } }));
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/public/uploads/photo') {
      const token = url.searchParams.get('token') ?? '';
      const key = tokens.get(token);
      if (!key) { response.writeHead(403).end(); return; }
      uploadCounts.set(key, (uploadCounts.get(key) ?? 0) + 1);
      if (request.headers['content-length'] === undefined) { response.writeHead(411).end(); return; }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        uploads.set(key, Buffer.concat(chunks));
        response.writeHead(201).end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake-engine-listen-failed');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, server, uploads, uploadCounts, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
