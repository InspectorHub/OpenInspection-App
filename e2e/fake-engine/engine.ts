import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface RendererEngine {
  url: string;
  setCompatibility(value: { minSupported?: string | null; recommended?: string | null; downloadUrl?: string | null }): void;
  requests: string[];
  uploads: Map<string, Buffer>;
  uploadCounts: Map<string, number>;
  uploadContentLengths: Array<number | null>;
  /** Every `GET /api/inspections/insp-7/photo`: the key, the `w` asked for and whether the Bearer session was right. */
  photoRequests: Array<{ key: string; w: string | null; authorized: boolean }>;
  activeUploadCount: number;
  /** Per key: how many upload responses were actually delivered with a 2xx (an attempt cut off by setUnavailable or an abort does not count). */
  completedCounts: Map<string, number>;
  /** Date.now() of every delivered 2xx upload response, in order. */
  completedAt: number[];
  /** While true the engine behaves like an unreachable host: every open connection is destroyed and new ones are reset at once. */
  setUnavailable(value: boolean): void;
  /** Request-body read failures that were NOT a connection abort. Specs should expect this to stay empty. */
  errors: string[];
  /** Changes the artificial per-upload response delay (0 = none) for uploads that start after the call. */
  setUploadDelay(ms: number): void;
  close(): Promise<void>;
}

export interface RendererEngineOptions {
  uploadDelayMs?: number;
  showInspection?: boolean;
  /** Interface to bind. Defaults to loopback; pass 0.0.0.0 to serve an Android emulator (10.0.2.2) from the host. */
  host?: string;
  /** Port to bind. 0 (default) picks a free one. */
  port?: number;
}

/** Origins the clients send: Electron and Android Capacitor (https://localhost), iOS Capacitor (capacitor://localhost), a plain-http dev shell. Anything else gets no ACAO header. */
export const ALLOWED_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];

/** Named option presets for the standalone CLI (`--scenario`). */
export const scenarios: Record<string, Partial<RendererEngineOptions>> = {
  default: {},
  /** The seeded inspection insp-7 is visible to the signed-in user, so the work list shows it. */
  inspection: { showInspection: true },
};

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
export async function startRendererEngine(options: RendererEngineOptions = {}): Promise<RendererEngine> {
  let url = '';
  let uploadDelayMs = options.uploadDelayMs ?? 0;
  const requests: string[] = [];
  const sockets = new Set<Duplex>();
  const connections = new Set<Socket>();
  const completedCounts = new Map<string, number>();
  const completedAt: number[] = [];
  const errors: string[] = [];
  let unavailable = false;
  const uploads = new Map<string, Buffer>();
  const uploadCounts = new Map<string, number>();
  const uploadContentLengths: Array<number | null> = [];
  const photoRequests: Array<{ key: string; w: string | null; authorized: boolean }> = [];
  const activeUploadResponses = new Set<import('node:http').ServerResponse>();
  const uploadTokens = new Map<string, string>();
  const compatibility = { minSupported: null as string | null, recommended: null as string | null, downloadUrl: null as string | null };
  const server: Server = createServer((request, response) => {
    const requestOrigin = request.headers.origin;
    if (typeof requestOrigin === 'string' && ALLOWED_ORIGINS.includes(requestOrigin)) response.setHeader('Access-Control-Allow-Origin', requestOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-client-platform,x-client-version');
    response.setHeader('Access-Control-Expose-Headers', 'date,x-client-upgrade');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    // Absolute URLs handed to clients follow the Host the client used (127.0.0.1, 10.0.2.2, localhost), so one engine serves every emulator.
    const origin = request.headers.host ? `http://${request.headers.host}` : url;
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
    if (request.method === 'GET' && route === '/api/inspections/insp-7/photo') {
      // Like the real route: the Bearer session is required (an <img> cannot send it), and with no image service the
      // original bytes come back whatever `w` says.
      const query = new URL(request.url ?? '/', url).searchParams;
      const key = query.get('key') ?? '';
      const authorized = request.headers.authorization === 'Bearer renderer-access-token';
      photoRequests.push({ key, w: query.get('w'), authorized });
      const stored = uploads.get(key);
      if (!authorized) { response.writeHead(401).end(); return; }
      if (stored === undefined) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': key.endsWith('.png') ? 'image/png' : 'image/jpeg', 'content-length': stored.length }).end(stored);
      return;
    }
    if (request.method === 'POST' && route === '/api/inspections/insp-7/media/upload-url') {
      void readBody(request).then((raw) => {
        const body = JSON.parse(raw.toString('utf8')) as { pendingId: string; contentType: string };
        const extension = body.contentType === 'image/jpeg' ? 'jpg' : body.contentType === 'image/png' ? 'png' : body.contentType === 'image/heic' ? 'heic' : null;
        if (extension === null) { json({ success: false }, 400); return; }
        const key = `renderer-tenant/inspections/insp-7/photos/${body.pendingId}.${extension}`;
        const token = `renderer123.${Math.random().toString(36).slice(2)}`;
        uploadTokens.set(token, key);
        json({ success: true, data: { url: `${origin}/api/public/uploads/photo?token=${token}`, key } });
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
        if (uploadDelayMs > 0) setTimeout(finish, uploadDelayMs);
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
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('renderer-engine-listen-failed');
  const host = options.host === undefined || options.host === '0.0.0.0' ? '127.0.0.1' : options.host === '::' ? '::1' : options.host;
  url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  return { url, setCompatibility: (value) => Object.assign(compatibility, value), requests, uploads, uploadCounts, uploadContentLengths, photoRequests, completedCounts, completedAt, errors, setUnavailable(value) {
    unavailable = value;
    if (value) for (const socket of connections) socket.destroy();
  }, setUploadDelay(ms) { uploadDelayMs = Math.max(0, ms); }, get activeUploadCount() { return activeUploadResponses.size; }, close: () => new Promise<void>((resolveClose) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolveClose());
    server.closeAllConnections();
  }) };
}
