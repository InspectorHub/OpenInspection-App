import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { resolve } from 'node:path';

export interface RendererEngine {
  url: string;
  setCompatibility(value: { minSupported?: string | null; recommended?: string | null; downloadUrl?: string | null }): void;
  requests: string[];
  uploads: Map<string, Buffer>;
  uploadCounts: Map<string, number>;
  uploadContentLengths: Array<number | null>;
  activeUploadCount: number;
  /** Per key: how many upload responses were actually delivered with a 2xx (an attempt cut off by setUnavailable or an abort does not count). */
  completedCounts: Map<string, number>;
  /** Date.now() of every delivered 2xx upload response, in order. */
  completedAt: number[];
  /** While true the engine behaves like an unreachable host: every open connection is destroyed and new ones are reset at once. */
  setUnavailable(value: boolean): void;
  /** Request-body read failures that were NOT a connection abort. Specs should expect this to stay empty. */
  errors: string[];
  close(): Promise<void>;
}

async function readBody(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function multipartFile(body: Buffer, contentType: string | undefined): Buffer | null {
  const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const value = boundary?.[1] ?? boundary?.[2]?.trim();
  if (!value) return null;
  const opening = Buffer.from(`--${value}\r\n`);
  if (!body.subarray(0, opening.length).equals(opening)) return null;
  const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), opening.length);
  if (headersEnd < 0) return null;
  const headers = body.subarray(opening.length, headersEnd).toString('latin1');
  if (!/content-disposition:\s*form-data;\s*name="file";/i.test(headers)) return null;
  const fileStart = headersEnd + 4;
  const fileEnd = body.indexOf(Buffer.from(`\r\n--${value}--\r\n`), fileStart);
  if (fileEnd < fileStart) return null;
  return body.subarray(fileStart, fileEnd);
}

/** Loopback engine for renderer visual QA and the real Diagnostics check path. */
export async function startRendererEngine(options: { uploadDelayMs?: number; showInspection?: boolean } = {}): Promise<RendererEngine> {
  let url = '';
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const connections = new Set<Socket>();
  const completedCounts = new Map<string, number>();
  const completedAt: number[] = [];
  const errors: string[] = [];
  let unavailable = false;
  const uploads = new Map<string, Buffer>();
  const uploadCounts = new Map<string, number>();
  const uploadContentLengths: Array<number | null> = [];
  const activeUploadResponses = new Set<import('node:http').ServerResponse>();
  const uploadTokens = new Map<string, string>();
  const compatibility = { minSupported: null as string | null, recommended: null as string | null, downloadUrl: null as string | null };
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
      json({ success: true, data: { ...compatibility, serverContractVersion: 2, accountUrl: null } });
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
    if (request.method === 'GET' && route === '/api/inspections/insp-7') {
      json({ success: true, data: { inspection: { id: 'insp-7', status: 'scheduled', date: '2026-11-01T10:00:00Z', inspectorId: 'renderer-user', propertyType: 'single_family', propertyAddress: '77 Test Photo Lane', reportStatus: 'in_progress', templateSnapshot: { schemaVersion: 2, sections: [{ id: 'sec_roof', title: 'Roof', items: [{ id: 'itm_cover', label: 'Roof cover', type: 'rich' }] }] } } } });
      return;
    }
    if (request.method === 'GET' && route === '/api/inspections/templates') { json({ success: true, data: [], meta: { page: 1, totalPages: 1 } }); return; }
    if (request.method === 'GET' && route === '/api/inspections/insp-7/media') { json({ success: true, data: [] }); return; }
    if (request.method === 'POST' && route === '/api/inspections/insp-7/media/upload-url') {
      void readBody(request).then((raw) => {
        const body = JSON.parse(raw.toString('utf8')) as { pendingId: string; contentType: string };
        const extension = body.contentType === 'image/jpeg' ? 'jpg' : body.contentType === 'image/png' ? 'png' : body.contentType === 'image/heic' ? 'heic' : null;
        if (extension === null) { json({ success: false }, 400); return; }
        const key = `renderer-tenant/inspections/insp-7/photos/${body.pendingId}.${extension}`;
        const token = `renderer123.${Math.random().toString(36).slice(2)}`;
        uploadTokens.set(token, key);
        json({ success: true, data: { url: `${url}/api/public/uploads/photo?token=${token}`, key } });
      });
      return;
    }
    if (request.method === 'POST' && route === '/api/public/uploads/photo') {
      const token = new URL(request.url ?? '/', url).searchParams.get('token') ?? '';
      const key = uploadTokens.get(token);
      const length = request.headers['content-length'];
      if (key === undefined) { response.writeHead(403).end(); return; }
      uploadCounts.set(key, (uploadCounts.get(key) ?? 0) + 1);
      activeUploadResponses.add(response);
      const releaseUploadSlot = () => activeUploadResponses.delete(response);
      response.once('close', releaseUploadSlot);
      response.once('finish', releaseUploadSlot);
      uploadContentLengths.push(length === undefined ? null : Number(length));
      void readBody(request).then((body) => {
        const file = multipartFile(body, request.headers['content-type']);
        const finish = () => {
          if (response.destroyed) return;
          if (length === undefined) { response.writeHead(411).end(); return; }
          if (file === null || file.length === 0) { response.writeHead(400).end(); return; }
          uploads.set(key, file);
          completedCounts.set(key, (completedCounts.get(key) ?? 0) + 1);
          completedAt.push(Date.now());
          response.writeHead(201).end();
        };
        if ((options.uploadDelayMs ?? 0) > 0) setTimeout(finish, options.uploadDelayMs);
        else finish();
      }, (error: unknown) => {
        // A connection destroyed mid-body rejects the read: that is an aborted attempt. Anything else is recorded, not hidden.
        const text = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}` : String(error);
        if (!/ECONNRESET|aborted|premature close/i.test(text)) errors.push(`upload body read: ${text}`);
      });
      return;
    }
    if (request.method === 'POST' && route === '/api/inspections/insp-7/collab/ticket') {
      json({ success: true, data: { ticket: 'renderer-collab-ticket-1234' } });
      return;
    }
    if (request.method === 'POST' && route === '/api/client/inspections/visible') {
      void readBody(request).then((raw) => {
        const body = JSON.parse(raw.toString('utf8')) as { ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
        json({ success: true, data: { visible: options.showInspection ? ids : [] } });
      });
      return;
    }
    if (route === '/api/inspections') {
      json({ success: true, data: [] });
      return;
    }
    json({ error: 'not-found' }, 404);
  });
  server.on('connection', (socket) => {
    if (unavailable) { socket.destroy(); return; }
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => undefined);
  });
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !request.url?.startsWith('/api/inspections/insp-7/collab/ws?ticket=')) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => {
      if (socket.destroyed || socket.writableEnded) return;
      socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    });
    socket.on('error', () => {});
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
  return { url, setCompatibility: (value) => Object.assign(compatibility, value), requests, uploads, uploadCounts, uploadContentLengths, completedCounts, completedAt, errors, setUnavailable(value) {
    unavailable = value;
    if (value) for (const socket of connections) socket.destroy();
  }, get activeUploadCount() { return activeUploadResponses.size; }, close: () => new Promise<void>((resolveClose) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolveClose());
    server.closeAllConnections();
  }) };
}
