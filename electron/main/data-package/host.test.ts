import { describe, expect, it } from 'vitest';
import { startExportFromRenderer, type ExportHostDeps, type StartExportRequest } from './host';
import type { RawResponse } from './http';
import type { DataPackageStateHost } from './state';
import type { ExportFs } from './types';

const ORIGIN = 'https://engine.test';

function memState(): DataPackageStateHost {
  return { async load() { return null; }, async save() {}, async clear() {} };
}
function memFs(): ExportFs {
  const files = new Map<string, Uint8Array>();
  return {
    async mkdir() {},
    async writeFile(p, d) { files.set(p, Uint8Array.from(d)); },
    async readFile(p) { const v = files.get(p); if (!v) throw new Error('missing'); return v; },
    async rename(o, n) { const v = files.get(o); if (!v) throw new Error('missing'); files.delete(o); files.set(n, v); },
  };
}
const raw = (status: number, json: unknown, url: string): RawResponse => ({
  status, url,
  headers: { get: () => null },
  body: new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer,
});

function fakeTransport(): NonNullable<ExportHostDeps['transport']> {
  return async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/auth/step-up') return raw(200, { success: true, data: { token: 'step-token', action: 'data-export-start', expiresAt: 'x' } }, req.url);
    if (u.pathname.endsWith('/jobs') && req.method === 'POST') return raw(200, { success: true, data: { jobId: 'job-1', jobToken: 'jt', snapshotAt: 1700000000000, schemaFingerprint: 'a'.repeat(64), serverVersion: '2.6.0' } }, req.url);
    if (u.pathname.endsWith('/tables')) return raw(200, { success: true, data: [{ table: 'inspections', columns: ['id'], keyset: ['id'], maxPageRows: 2, maxPageBytes: 4096 }] }, req.url);
    if (u.pathname.endsWith('/rows')) {
      const after = u.searchParams.get('after');
      const rows = after === null ? [{ id: 1 }] : [];
      return raw(200, { success: true, data: { rows, next: null, bytes: 0, rowsScanned: rows.length } }, req.url);
    }
    if (u.pathname.endsWith('/media')) return raw(200, { success: true, data: { objects: [], cursor: null, truncated: false } }, req.url);
    if (u.pathname.endsWith('/heartbeat')) return raw(200, { success: true, data: { jobToken: 'jt-hb', leaseExpiresAt: 'x' } }, req.url);
    if (u.pathname.endsWith('/abort')) return raw(200, { success: true }, req.url);
    if (u.pathname.endsWith('/complete')) return raw(200, { success: true }, req.url);
    throw new Error('unexpected ' + u.pathname);
  };
}

function deps(over: Partial<ExportHostDeps> = {}): ExportHostDeps {
  return {
    state: memState(), files: memFs(), baseDir: '/out', now: () => 1700000000000,
    sleep: async () => {}, log: () => {}, onProgress: async () => {},
    redact: (s) => s, transport: fakeTransport(), ...over,
  };
}

const req: StartExportRequest = {
  serverUrl: ORIGIN, bearer: 'bearer-secret', stepUpPassword: 'pw', deviceLabel: 'D',
  clientKind: 'desktop-windows',
};

describe('startExportFromRenderer', () => {
  it('obtains a step-up token, runs the export and reports progress', async () => {
    const progress: string[] = [];
    const d = deps({ onProgress: async (p) => { progress.push(p.stage); } });
    const result = await startExportFromRenderer(d, req);
    expect(result.selfCheck.ok).toBe(true);
    expect(result.rows).toBe(1);
    expect(progress).toContain('rows');
    expect(progress).toContain('verifying');
  });

  it('refuses a server URL with a path or wrong scheme', async () => {
    await expect(startExportFromRenderer(deps(), { ...req, serverUrl: `${ORIGIN}/evil` })).rejects.toThrow('invalid-server-url');
    await expect(startExportFromRenderer(deps(), { ...req, serverUrl: 'ftp://engine.test' })).rejects.toThrow();
  });

  it('fails closed when step-up does not return a native token', async () => {
    const d = deps({ transport: async (r) => {
      const u = new URL(r.url);
      if (u.pathname === '/api/auth/step-up') return raw(200, { success: true, data: { action: 'data-export-start' } }, r.url); // no token (browser path)
      return fakeTransport()(r);
    } });
    await expect(startExportFromRenderer(d, req)).rejects.toThrow('step-up-token');
  });

  it('never writes the password or bearer into log lines', async () => {
    const lines: string[] = [];
    // Identity redactor on purpose: the property under test is that no log
    // line ever CONTAINS a secret, not that a redactor happens to hide it.
    const d = deps({ log: (l) => lines.push(l), redact: (s) => s });
    await startExportFromRenderer(d, req);
    const all = lines.join('\n');
    expect(all).not.toContain('pw');
    expect(all).not.toContain('bearer-secret');
    expect(all).not.toContain('step-token');
  });
});
