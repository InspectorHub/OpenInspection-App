import { createServer, type Server } from 'node:http';
import type { RendererEngine } from './engine.ts';

export interface ControlServer {
  origin: string;
  close(): Promise<void>;
}

async function readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/**
 * Test-only control surface for a standalone engine. It listens on its OWN loopback-only port (never on the
 * engine port, which an emulator can reach and which setUnavailable cuts off), and only under /__test__/.
 *
 *   GET  /__test__/state              counters and the request log
 *   POST /__test__/unavailable        {"value": true|false}   behave like an unreachable host
 *   POST /__test__/upload-delay       {"ms": number}          delay every upload response
 *   POST /__test__/compatibility      {"minSupported"?, "recommended"?, "downloadUrl"?}
 */
export async function startControlServer(engine: RendererEngine): Promise<ControlServer> {
  let port = 0;
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
    const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (!loopback || !route.startsWith('/__test__/')) { send(404, { error: 'not-found' }); return; }
    // DNS-rebinding and CSRF defence: only a direct loopback client may call this. A browser page always sends Origin on
    // cross-site writes, and a rebound hostname arrives with a foreign Host.
    if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) { send(403, { error: 'bad-host' }); return; }
    if (request.headers.origin !== undefined) { send(403, { error: 'origin-not-allowed' }); return; }
    if (request.method === 'POST' && !/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) { send(415, { error: 'json-required' }); return; }
    if (request.method === 'GET' && route === '/__test__/state') {
      send(200, {
        requests: engine.requests,
        uploadKeys: [...engine.uploads.keys()],
        uploadCounts: Object.fromEntries(engine.uploadCounts),
        completedCounts: Object.fromEntries(engine.completedCounts),
        photoRequests: engine.photoRequests,
        activeUploadCount: engine.activeUploadCount,
        errors: engine.errors,
      });
      return;
    }
    if (request.method !== 'POST') { send(405, { error: 'method-not-allowed' }); return; }
    void readJson(request).then((body) => {
      if (route === '/__test__/unavailable' && typeof body.value === 'boolean') { engine.setUnavailable(body.value); send(200, { ok: true }); return; }
      if (route === '/__test__/upload-delay' && typeof body.ms === 'number') { engine.setUploadDelay(body.ms); send(200, { ok: true }); return; }
      if (route === '/__test__/compatibility') {
        const pick = (key: string): string | null | undefined => (typeof body[key] === 'string' || body[key] === null ? (body[key] as string | null) : undefined);
        engine.setCompatibility({ minSupported: pick('minSupported'), recommended: pick('recommended'), downloadUrl: pick('downloadUrl') });
        send(200, { ok: true });
        return;
      }
      send(404, { error: 'not-found' });
    }, () => send(400, { error: 'bad-json' }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('control-listen-failed');
  port = address.port;
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }) };
}
