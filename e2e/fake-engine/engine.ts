import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { paths } from '../../src/api/schema';

/**
 * The success body the engine's contract promises for a route: the JSON of its 2xx answer in src/api/schema.d.ts, which `npm run api:types`
 * generates from the engine's contract. `contract<'/api/x', 'get'>()({ ... })` returns its argument unchanged and fails the type-check when the
 * argument is not what the contract says, so a change of the contract (a field added, renamed, made required) cannot pass here unseen.
 * Only the SHAPE is checked at compile time; e2e/fake-engine/contract.test.ts checks the real values against the contract's schemas.
 */
type SuccessBody<Operation> = Operation extends { responses: infer R }
  ? { [Status in keyof R & (200 | 201)]: R[Status] extends { content: { 'application/json': infer Body } } ? Body : never }[keyof R & (200 | 201)]
  : never;
function contract<Path extends keyof paths, Method extends keyof paths[Path]>(): (body: SuccessBody<paths[Path][Method]>) => SuccessBody<paths[Path][Method]> {
  return (body) => body;
}

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
  /** Every ACCEPTED `POST /api/inspections/insp-7/cover`: the source photo key, the crop JSON and the size of the baked image. Refusals are not recorded. */
  covers: Array<{ sourceKey: string; crop: string; bytes: number }>;
  /** Every accepted `POST /api/client/import`: what reached the engine, so a spec can compare it with the file it sent. */
  imports: Array<{ contentLength: number | null; byteLength: number; sha256: string; elapsedMs: number; inspections: number }>;
  /** Where the seeded report stands: `draft`, `locked` (published) or `editing` (reopened with edit-again), and the version clients read. */
  report: { state: 'draft' | 'locked' | 'editing'; version: number | null };
  /** Every `POST /api/inspections/insp-7/publish`: the notice choice sent, the summary, and whether it made a new version. */
  publishes: Array<{ notifyClient: boolean | null; summary: string | null; outcome: 'new_version' | 'unchanged' }>;
  /** Every `POST /api/inspections/insp-7/edit-again`. */
  reopens: number;
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
  /** The seeded inspection starts as a report published as version 3: locked until `edit-again`, as the engine does. */
  published?: boolean;
  /** Interface to bind. Defaults to loopback; pass 0.0.0.0 to serve an Android emulator (10.0.2.2) from the host. */
  host?: string;
  /** Port to bind. 0 (default) picks a free one. */
  port?: number;
  /** Further origins echoed in CORS, on top of ALLOWED_ORIGINS (a dev bundle served from the host, for example). */
  extraAllowedOrigins?: string[];
  /** Serve HTTPS instead of HTTP (a packaged desktop build only connects to https). The caller owns the certificate. */
  tls?: { cert: string | Buffer; key: string | Buffer };
}

/** Origins the clients send: Electron and Android Capacitor (https://localhost), iOS Capacitor (capacitor://localhost), a plain-http dev shell. Anything else gets no ACAO header. */
export const ALLOWED_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];

/** Named option presets for the standalone CLI (`--scenario`). */
export const scenarios: Record<string, Partial<RendererEngineOptions>> = {
  default: {},
  /** The seeded inspection insp-7 is visible to the signed-in user, so the work list shows it. */
  inspection: { showInspection: true },
  /** As `inspection`, with the report published (version 3): read-only until "Edit and republish". */
  published: { showInspection: true, published: true },
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

/** Every part of a multipart body: its field name and bytes. Enough for the cover form (an image file plus two text fields). */
function multipartParts(body: Buffer, contentType: string | undefined): Map<string, Buffer> | null {
  const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const value = boundary?.[1] ?? boundary?.[2]?.trim();
  if (!value) return null;
  const parts = new Map<string, Buffer>();
  const delimiter = Buffer.from(`--${value}`);
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString('latin1') === '--') break;
    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
    const next = body.indexOf(delimiter, headersEnd + 4);
    if (headersEnd < 0 || next < 0) return null;
    const name = /name="([^"]*)"/i.exec(body.subarray(start, headersEnd).toString('latin1'))?.[1];
    if (name !== undefined) parts.set(name, body.subarray(headersEnd + 4, next - 2));
    at = next;
  }
  return parts;
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
  const covers: Array<{ sourceKey: string; crop: string; bytes: number }> = [];
  const errors: string[] = [];
  let unavailable = false;
  const uploads = new Map<string, Buffer>();
  const uploadCounts = new Map<string, number>();
  const uploadContentLengths: Array<number | null> = [];
  const imports: RendererEngine['imports'] = [];
  const report: RendererEngine['report'] = options.published === true ? { state: 'locked', version: 3 } : { state: 'draft', version: null };
  const publishes: RendererEngine['publishes'] = [];
  let reopens = 0;
  const photoRequests: Array<{ key: string; w: string | null; authorized: boolean }> = [];
  const activeUploadResponses = new Set<import('node:http').ServerResponse>();
  const uploadTokens = new Map<string, string>();
  const compatibility = { minSupported: null as string | null, recommended: null as string | null, downloadUrl: null as string | null };
  const allowedOrigins = [...ALLOWED_ORIGINS, ...(options.extraAllowedOrigins ?? [])];
  const scheme = options.tls === undefined ? 'http' : 'https';
  const server: Server | HttpsServer = (options.tls === undefined ? createServer() : createHttpsServer(options.tls)).on('request', (request, response) => {
    const requestOrigin = request.headers.origin;
    if (typeof requestOrigin === 'string' && allowedOrigins.includes(requestOrigin)) response.setHeader('Access-Control-Allow-Origin', requestOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,idempotency-key,x-client-platform,x-client-version');
    response.setHeader('Access-Control-Expose-Headers', 'date,x-client-upgrade');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,PATCH,DELETE');
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    // Absolute URLs handed to clients follow the Host the client used (127.0.0.1, 10.0.2.2, localhost), so one engine serves every emulator.
    const origin = request.headers.host ? `${scheme}://${request.headers.host}` : url;
    const route = new URL(request.url ?? '/', url).pathname;
    requests.push(`${request.method ?? 'GET'} ${route}`);
    const json = (body: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.method === 'GET' && route === '/api/client/compat') {
      json(contract<'/api/client/compat', 'get'>()({ success: true, data: { ...compatibility, serverContractVersion: 2 } }));
      return;
    }
    if (request.method === 'GET' && route === '/oauth/authorize') {
      // Test-only sign-in page: no user interaction, it sends the browser straight back to the app with a fixed code.
      const query = new URL(request.url ?? '/', url).searchParams;
      const redirect = query.get('redirect_uri') ?? '';
      const state = query.get('state') ?? '';
      let target: URL | null = null;
      try { target = new URL(redirect); } catch { target = null; }
      const appCallback = target !== null && target.protocol === 'io.inspectorhub.app:' && target.pathname === '/oauth/callback';
      const loopback = target !== null && (target.protocol === 'http:' || target.protocol === 'https:') && (target.hostname === '127.0.0.1' || target.hostname === 'localhost');
      if (target === null || !(appCallback || loopback) || state === '') { response.writeHead(400, { 'content-type': 'text/plain' }).end('bad authorize request'); return; }
      target.searchParams.set('code', 'renderer-auth-code');
      target.searchParams.set('state', state);
      response.writeHead(302, { location: target.toString() }).end();
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
      json(contract<'/api/client/session', 'get'>()({ success: true, data: { userId: 'renderer-user', tenantId: 'renderer-tenant', role: 'inspector', offlineMaxDays: 30, tenantName: null, serverNowMs: Date.now() } }));
      return;
    }
    if (request.method === 'GET' && route === '/api/session/context') {
      json(contract<'/api/session/context', 'get'>()({ success: true, data: {
        user: {
          sessionMarker: 'renderer-session', name: 'Renderer User', email: 'renderer@example.test', role: 'inspector', initials: 'RU',
          // What an inspector without extra rights is given.
          capabilities: { publish: true, scheduleOthers: false, inspectionFees: false, companyFinance: false, manageContacts: false, viewCommunication: false, templateCreate: false, templateEdit: false, templateDelete: false, templateImport: false, deleteInspection: false, editReports: true, viewAllInspections: false },
          timezone: 'America/New_York', locale: 'en-US', dateFormat: 'us', timeFormat: '12h',
        },
        branding: {
          companyName: 'Renderer Test', primaryColor: '#6366f1', logoUrl: null, defaultProfileId: 'default', isSaas: false, portalBaseUrl: null,
          tenantSlug: 'renderer-test', tenantStatus: 'active', currentUserSlug: null, bookingHost: null, privacyUrl: null, termsUrl: null,
          defaultTimezone: 'America/New_York', holidayRegion: null, defaultLocale: 'en-US', currency: 'USD', archiveRevokesAccess: false, dateFormat: 'us', timeFormat: '12h',
        },
        deployment: { mode: 'standalone', hasBilling: false, hasSeatQuota: false, mcpEnabled: false, connectedAppsEnabled: false, videoBackendManaged: false, hasManagedCompliance: false, hasAssistedMigration: false },
        seatUsage: null, videoProvider: 'r2', outboundCoolingWindow: null, collabEditing: false, unreadMessages: 0,
      } }));
      return;
    }
    if (request.method === 'GET' && route === '/api/tags') { json(contract<'/api/tags', 'get'>()({ success: true, data: [] })); return; }
    // The per-inspection tag map (itemId -> tags) the app downloads with an inspection; empty here. Without it the app logged a 404 on every download.
    if (request.method === 'GET' && route === '/api/inspections/insp-7/tags') { json(contract<'/api/inspections/{id}/tags', 'get'>()({ success: true, data: {} })); return; }
    if (request.method === 'GET' && route === '/api/recommendations') { json(contract<'/api/recommendations', 'get'>()({ success: true, data: [] })); return; }
    if (request.method === 'GET' && route === '/api/contractor-types') { json(contract<'/api/contractor-types', 'get'>()({ success: true, data: [] })); return; }
    // The company's editor preferences, which Settings reads on open. The contract does not list this route; the answer is the preferences object itself, as the engine sends it.
    if (request.method === 'GET' && route === '/api/tenant/inspection-prefs') { json({ cloneDefault: 'rating_notes', autoAdvance: 'keyboard', autoAdvanceDelayMs: 200, pinnedTagIds: [], requireDefectFields: 'none', agentRepairAccess: 'read', reportLinkTtl: { count: 2, unit: 'years' } }); return; }
    if (request.method === 'GET' && route === '/api/admin/defect-categories') { json(contract<'/api/admin/defect-categories', 'get'>()({ success: true, data: [] })); return; }
    if (request.method === 'GET' && route === '/api/inspections/insp-7') {
      const inspection = contract<'/api/inspections/{id}', 'get'>()({ success: true, data: { inspection: { id: 'insp-7', status: 'scheduled', date: '2026-11-01T10:00:00Z', inspectorId: 'renderer-user', propertyAddress: '77 Test Photo Lane', clientName: null, clientEmail: null, templateId: null, createdAt: '2026-10-31T10:00:00Z', templateSnapshot: { schemaVersion: 2, sections: [{ id: 'sec_roof', title: 'Roof', items: [{ id: 'itm_cover', label: 'Roof cover', type: 'rich' }] }] } }, primaryReportId: null, publishedVersionNumber: report.version, editingAgain: report.state === 'editing', contentLocked: report.state === 'locked' } });
      // The app reads these two (src/field/editor-data.ts) and the contract does not list them for this route: kept, and named here so they are
      // not mistaken for documented fields. See docs/fake-engine-contract.md.
      json({ ...inspection, data: { ...inspection.data, inspection: { ...inspection.data.inspection, propertyType: 'single_family', reportStatus: report.state === 'draft' ? 'in_progress' : 'published' } } });
      return;
    }
    if (request.method === 'GET' && route === '/api/inspections/templates') { json(contract<'/api/inspections/templates', 'get'>()({ success: true, data: [], meta: { page: 1, totalPages: 1, total: 0, pageSize: 20 } })); return; }
    // The two reads the offline editor needs besides the inspection row itself (a download without them is "not downloaded").
    if (request.method === 'GET' && route === '/api/inspections/insp-7/results') { json(contract<'/api/inspections/{id}/results', 'get'>()({ success: true, data: { results: {}, resultId: null } })); return; }
    if (request.method === 'GET' && route === '/api/inspections/insp-7/report-data') { { const reportData = contract<'/api/inspections/{id}/report-data', 'get'>()({ success: true, data: { inspection: { id: 'insp-7', propertyAddress: '77 Test Photo Lane', date: '2026-11-01T10:00:00Z', status: 'scheduled', inspectorName: null }, styleProfile: { id: 'default', name: 'Default', schemaVersion: 1, colour: null, badgeLayout: 'strip', photoColumns: 2, tokens: {} }, inspectorCredentials: [], stats: { total: 1, satisfactory: 0, monitor: 0, defect: 0 }, sections: [{ id: 'sec_roof', title: 'Roof', defectCount: 0, items: [{ id: 'itm_cover', label: 'Roof cover', rating: null, ratingColor: '', ratingLabel: null, severityBucket: 'other', notes: null, photos: [] }] }], ratingLevels: [] } });
      // `type` is not in the contract's report-data item, and the app needs it: buildSchema (src/field/loader-schema.ts) takes these sections
      // INSTEAD of the template's, and the editor shows the rating row only for type 'rich'. Kept, and named: docs/fake-engine-contract.md.
      json({ ...reportData, data: { ...reportData.data, sections: reportData.data.sections.map((section) => ({ ...section, items: section.items.map((item) => ({ ...item, type: 'rich' })) })) } }); }; return; }
    if (request.method === 'GET' && route === '/api/inspections/insp-7/media') { json(contract<'/api/inspections/{id}/media', 'get'>()({ success: true, data: { attached: [], pool: [] } })); return; }
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
    if (request.method === 'POST' && route === '/api/inspections/insp-7/cover') {
      // Like the real route (POST /{id}/cover): needs the Bearer session; 400 when the image is missing or the source key is
      // not a photo of this inspection; 413 over 10 MiB. The answer carries the stored key as `coverImageKey`.
      if (request.headers.authorization !== 'Bearer renderer-access-token') { request.resume(); json({ success: false }, 401); return; }
      void readBody(request).then((raw) => {
        const parts = multipartParts(raw, request.headers['content-type']);
        const image = parts?.get('image');
        const sourceKey = parts?.get('sourceKey')?.toString('utf8') ?? '';
        if (image !== undefined && image.length > 10 * 1024 * 1024) { json({ success: false }, 413); return; }
        if (image === undefined || image.length === 0 || !uploads.has(sourceKey)) { json({ success: false }, 400); return; }
        covers.push({ sourceKey, crop: parts?.get('crop')?.toString('utf8') ?? '', bytes: image.length });
        json(contract<'/api/inspections/{id}/cover', 'post'>()({ success: true, data: { coverImageKey: `renderer-tenant/inspections/insp-7/covers/${covers.length}.jpg` } }));
      });
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
        json(contract<'/api/inspections/{id}/media/upload-url', 'post'>()({ success: true, data: { url: `${origin}/api/public/uploads/photo?token=${token}`, key, expiresAt: Date.now() + 3_600_000 } }));
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
      json(contract<'/api/inspections/{id}/collab/ticket', 'post'>()({ success: true, data: { ticket: 'renderer-collab-ticket-1234', expiresIn: 60, features: [] } }));
      return;
    }
    if (request.method === 'POST' && route === '/api/client/import') {
      // Like the real route: needs the Bearer session, application/zip and a Content-Length. The body is read whole and only
      // measured (declared length, bytes read, sha256, time); the answer confirms every inspection in the package.
      if (request.headers.authorization !== 'Bearer renderer-access-token') { request.resume(); json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401); return; }
      if (!/^application\/zip\s*(;|$)/i.test(request.headers['content-type'] ?? '')) { request.resume(); json({ success: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'application/zip required' } }, 415); return; }
      const declared = request.headers['content-length'];
      if (declared === undefined) { request.resume(); json({ success: false, error: { code: 'LENGTH_REQUIRED', message: 'Content-Length required' } }, 411); return; }
      const started = performance.now();
      void readBody(request).then(async (zip) => {
        const elapsedMs = Math.round(performance.now() - started);
        const { readPackageSummary } = await import('@inspectorhub/offline-package');
        const { counts } = readPackageSummary(new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength));
        imports.push({ contentLength: Number(declared), byteLength: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), elapsedMs, inspections: counts.inspections });
        json(contract<'/api/client/import', 'post'>()({ success: true, data: { inspections: counts.inspections, photos: counts.photos, outbox: { applied: counts.writes, skipped: 0, failed: [] }, yjs: { changed: counts.inspections, unchanged: 0 } } }));
      }).catch((error: unknown) => {
        // A connection destroyed mid-body is an aborted attempt; anything else (an unreadable package included) is recorded, not hidden.
        const text = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}` : String(error);
        if (!/ECONNRESET|aborted|premature close/i.test(text)) errors.push(`import: ${text}`);
        if (!response.headersSent && !response.destroyed) json({ success: false, error: { code: 'INVALID_PACKAGE', message: 'unreadable package' } }, 400);
      });
      return;
    }
    if (request.method === 'POST' && route === '/api/client/inspections/visible') {
      void readBody(request).then((raw) => {
        const body = JSON.parse(raw.toString('utf8')) as { ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
        json(contract<'/api/client/inspections/visible', 'post'>()({ success: true, data: { visible: options.showInspection ? ids : [] } }));
      });
      return;
    }
    if (route === '/api/inspections') {
      // The list the work-list download reads: the seeded inspection when the scenario shows it, so a fresh device can download it.
      json(contract<'/api/inspections', 'get'>()({ success: true, data: options.showInspection ? [{ id: 'insp-7', status: 'scheduled', date: '2026-11-01T10:00:00Z', propertyAddress: '77 Test Photo Lane', clientName: null, clientEmail: null, inspectorId: 'renderer-user', templateId: null, createdAt: '2026-10-31T10:00:00Z', publishedVersionNumber: report.version, editingAgain: report.state === 'editing' }] : [], meta: { nextCursor: null } }));
      return;
    }
    // The publish dialog sets the sign-on-publish flag first (a PATCH on the inspection) and does not publish if that write fails.
    if (request.method === 'PATCH' && route === '/api/inspections/insp-7') {
      void readBody(request).then(() => { json({ success: true, data: {} }); });
      return;
    }
    // "Edit and republish": only a published report can be opened again; the answer is the same when it is already open.
    if (request.method === 'POST' && route === '/api/inspections/insp-7/edit-again') {
      void readBody(request).then(() => {
        if (report.state === 'draft') { json({ success: false, error: { code: 'BAD_REQUEST', message: 'Only a published report can be edited again.' } }, 400); return; }
        reopens += 1;
        report.state = 'editing';
        json(contract<'/api/inspections/{id}/edit-again', 'post'>()({ success: true, data: { reportId: 'rep-7', state: 'editing' } }));
      });
      return;
    }
    // A publish makes a new version only when something was said (a summary stands for an edit here); otherwise it is the "nothing changed" answer.
    if (request.method === 'POST' && route === '/api/inspections/insp-7/publish') {
      void readBody(request).then((raw) => {
        let body: { summary?: unknown; notifyClient?: unknown } = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}') as typeof body; } catch { body = {}; }
        const summary = typeof body.summary === 'string' && body.summary.trim() !== '' ? body.summary.trim() : null;
        const reportUrl = `${origin}/report/renderer-test/insp-7`;
        if (report.state === 'locked' || (report.state === 'editing' && summary === null)) {
          publishes.push({ notifyClient: typeof body.notifyClient === 'boolean' ? body.notifyClient : null, summary, outcome: 'unchanged' });
          report.state = 'locked';
          json(contract<'/api/inspections/{id}/publish', 'post'>()({ success: true, data: { reportUrl, reportStatus: 'published', isnSync: null, unchangedSinceVersion: report.version ?? 1 } }));
          return;
        }
        publishes.push({ notifyClient: typeof body.notifyClient === 'boolean' ? body.notifyClient : null, summary, outcome: 'new_version' });
        report.version = (report.version ?? 0) + 1;
        report.state = 'locked';
        json(contract<'/api/inspections/{id}/publish', 'post'>()({ success: true, data: { reportUrl, reportStatus: 'published', isnSync: null } }));
      });
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
  url = `${scheme}://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  return { url, setCompatibility: (value) => Object.assign(compatibility, value), requests, uploads, uploadCounts, uploadContentLengths, imports, photoRequests, report, publishes, get reopens() { return reopens; }, completedCounts, completedAt, covers, errors, setUnavailable(value) {
    unavailable = value;
    if (value) for (const socket of connections) socket.destroy();
  }, setUploadDelay(ms) { uploadDelayMs = Math.max(0, ms); }, get activeUploadCount() { return activeUploadResponses.size; }, close: () => new Promise<void>((resolveClose) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolveClose());
    server.closeAllConnections();
  }) };
}
