import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface RendererEngine {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

async function readBody(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Loopback engine for renderer visual QA and the real Diagnostics check path. */
export async function startRendererEngine(): Promise<RendererEngine> {
  let url = '';
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'https://localhost');
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-client-platform,x-client-version');
    response.setHeader('Access-Control-Expose-Headers', 'date,x-client-upgrade');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    const route = new URL(request.url ?? '/', url).pathname;
    requests.push(`${request.method ?? 'GET'} ${route}`);
    const json = (body: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.method === 'GET' && route === '/api/client/compat') {
      json({ success: true, data: { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, accountUrl: null } });
      return;
    }
    if (request.method === 'POST' && route === '/oauth/register') {
      void readBody(request).then(() => json({ client_id: 'renderer-test-client' }));
      return;
    }
    if (request.method === 'POST' && route === '/oauth/token') {
      void readBody(request).then(() => json({ access_token: 'renderer-access-token', refresh_token: 'renderer-refresh-token', token_type: 'Bearer', expires_in: 3600, scope: 'native' }));
      return;
    }
    if (request.method === 'GET' && route === '/api/client/session') {
      json({ success: true, data: { userId: 'renderer-user', tenantId: 'renderer-tenant', role: 'inspector', offlineMaxDays: 30, serverNowMs: Date.now() } });
      return;
    }
    if (request.method === 'GET' && route === '/api/session/context') {
      json({ success: true, data: { user: { role: 'inspector', timezone: 'America/New_York', locale: 'en-US', dateFormat: 'us', timeFormat: '12h' }, branding: { tenantSlug: 'renderer-test', defaultTimezone: 'America/New_York', defaultLocale: 'en-US', dateFormat: 'us', timeFormat: '12h' }, videoProvider: 'r2', collabEditing: false } });
      return;
    }
    if (request.method === 'GET' && route === '/api/tags') { json({ success: true, data: [] }); return; }
    if (request.method === 'GET' && route === '/api/recommendations') { json({ success: true, data: [] }); return; }
    if (request.method === 'GET' && route === '/api/contractor-types') { json({ success: true, data: [] }); return; }
    if (request.method === 'GET' && route === '/api/admin/defect-categories') { json({ success: true, data: [] }); return; }
    if (request.method === 'POST' && route === '/api/inspections/insp-7/media/upload-url') {
      void readBody(request).then((raw) => {
        const body = JSON.parse(raw.toString('utf8')) as { pendingId: string };
        json({ success: true, data: { url: `${url}/api/public/uploads/photo?token=renderer123.upload123`, key: `renderer-tenant/inspections/insp-7/photos/${body.pendingId}.jpg` } });
      });
      return;
    }
    if (request.method === 'POST' && route === '/api/public/uploads/photo') {
      void readBody(request).then(() => response.writeHead(201).end());
      return;
    }
    if (request.method === 'POST' && route === '/api/inspections/insp-7/collab/ticket') {
      json({ success: true, data: { ticket: 'renderer-collab-ticket-1234' } });
      return;
    }
    if (route === '/api/inspections' || route === '/api/client/inspections/visible') {
      json({ success: true, data: [] });
      return;
    }
    json({ error: 'not-found' }, 404);
  });
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !request.url?.startsWith('/api/inspections/insp-7/collab/ws?ticket=')) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => { socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])); socket.end(); });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('renderer-engine-listen-failed');
  url = `http://127.0.0.1:${address.port}`;
  // The cert file is only read to ensure the public test fixture stays available with this E2E bundle.
  await readFile(resolve('e2e-electron/fixtures/loopback-cert.pem'));
  return { url, requests, close: () => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }) };
}
