import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExport, type ExportRunnerDeps } from './exporter';
import { dataPackageEndpoints } from './config';
import type { DataPackageStateHost, JobCheckpoint } from './state';
import type { ExportFs } from './types';
import type { DataPackageHttp, DataPackageResponse } from './http';

const ORIGIN = 'https://engine.test';
const EP = dataPackageEndpoints(ORIGIN);

function memState(initial: JobCheckpoint | null = null): DataPackageStateHost & { saves: JobCheckpoint[]; cleared: boolean } {
  const saves: JobCheckpoint[] = [];
  return {
    saves, cleared: false,
    async load() { return initial; },
    async save(c) { saves.push(c); },
    async clear() { this.cleared = true; },
  };
}

function memFs(): ExportFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async mkdir() {},
    async writeFile(path, data) { files.set(path, Uint8Array.from(data)); },
    async readFile(path) { const v = files.get(path); if (!v) throw new Error('missing'); return v; },
    async rename(oldPath, newPath) { const v = files.get(oldPath); if (!v) throw new Error('missing'); files.delete(oldPath); files.set(newPath, v); },
  };
}

const ok = (json: unknown): DataPackageResponse => ({ status: 200, text: JSON.stringify(json), json, budget: null, retryAfterMs: null });

function fakeHttp(over: Partial<Record<string, (url: URL, method: string) => DataPackageResponse>> = {}): DataPackageHttp {
  return {
    async request(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === '/api/admin/data-package/jobs' && req.method === 'POST') {
        return ok({ success: true, data: { jobId: 'job-123', jobToken: 'tok-1', snapshotAt: 1700000000000, schemaFingerprint: 'a'.repeat(64), serverVersion: '2.6.0' } });
      }
      if (p.endsWith('/tables')) {
        return ok({ success: true, data: [{ table: 'inspections', columns: ['id'], keyset: ['id'], maxPageRows: 2, maxPageBytes: 4096 }] });
      }
      if (p.endsWith('/rows')) {
        const after = url.searchParams.get('after');
        if (after === null) return ok({ success: true, data: { rows: [{ id: 1 }, { id: 2 }], next: 'cur-2', bytes: 0, rowsScanned: 2 } });
        return ok({ success: true, data: { rows: [{ id: 3 }], next: null, bytes: 0, rowsScanned: 1 } });
      }
      if (p.endsWith('/media')) {
        return ok({ success: true, data: { objects: [{ key: 'media/a.jpg', size: 3, etag: 'e', uploaded: 1, contentType: 'image/jpeg', kind: 'image' }], cursor: null, truncated: false } });
      }
      if (p.endsWith('/complete')) return ok({ success: true });
      if (p.endsWith('/heartbeat')) return ok({ success: true, data: { jobToken: 'tok-hb', leaseExpiresAt: '2026-11-18T01:00:00Z' } });
      if (p.endsWith('/resume')) return ok({ success: true, data: { jobToken: 'tok-2', leaseExpiresAt: '2026-11-18T01:00:00Z' } });
      for (const [key, fn] of Object.entries(over)) if (p.includes(key) && fn) return fn(url, req.method);
      throw new Error('unexpected request ' + p);
    },
  };
}

function deps(over: Partial<ExportRunnerDeps> = {}): ExportRunnerDeps {
  return {
    http: fakeHttp(), endpoints: EP,
    credentials: { bearer: 'bearer-secret', jobToken: 'tok-1' },
    state: memState(), files: memFs(), baseDir: '/out',
    now: () => 1700000000000, sleep: async () => {}, log: () => {},
    binaryGet: async () => ({ status: 200, bytes: new Uint8Array([1, 2, 3]) }),
    ...over,
  };
}

const opts = {
  deviceLabel: 'DESKTOP-1', clientKind: 'desktop-windows', stepUpToken: 'stepup-secret',
  originHost: 'engine.test',
};

describe('runExport', () => {
  it('runs the full flow and clears the checkpoint on success', async () => {
    const d = deps();
    const result = await runExport(d, opts);
    expect(result.rows).toBe(3);
    expect(result.media).toBe(1);
    expect(result.selfCheck.ok).toBe(true);
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((d.state as ReturnType<typeof memState>).saves.length).toBeGreaterThanOrEqual(2);
    expect((d.state as ReturnType<typeof memState>).cleared).toBe(true);
    const written = [...(d.files as ReturnType<typeof memFs>).files.keys()];
    expect(written.some((p) => p.endsWith('manifest.json'))).toBe(true);
    expect(written.some((p) => p.endsWith('media-001.zip'))).toBe(true);
  });

  it('never writes secrets into the checkpoint or manifest', async () => {
    const d = deps();
    await runExport(d, opts);
    const saved = JSON.stringify((d.state as ReturnType<typeof memState>).saves);
    expect(saved).not.toContain('bearer-secret');
    expect(saved).not.toContain('stepup-secret');
    expect(saved).not.toContain('tok-1');
  });

  it('resumes an existing job, refreshing the job token', async () => {
    const existing: JobCheckpoint = {
      jobId: 'job-123', kind: 'export', deviceLabel: 'DESKTOP-1', snapshotAt: 1700000000000,
      stage: 'rows', tables: { inspections: { cursor: 'cur-2', rows: 0, bytes: 0, shards: [], shardRows: [] } },
      counts: { rows: 0, media: 0 }, bytes: 0,
      meta: { schemaFingerprint: 'a'.repeat(64), serverVersion: '2.6.0' }, updatedAt: 1700000000000,
    };
    const d = deps({ state: memState(existing) });
    const result = await runExport(d, opts);
    // resume yields tok-2, then the heartbeat renews it to tok-hb.
    expect(d.credentials.jobToken).toBe('tok-hb');
    // An interrupted table (cursor set, no published shards) is re-read from
    // page 1 — table-level resume never drops rows by skipping an unpersisted cursor.
    expect(result.rows).toBe(3);
  });

  it('does not attest completion when writing a file fails', async () => {
    let completeCalled = false;
    const base = deps();
    const d = deps({
      http: fakeHttp({ complete: () => { completeCalled = true; return ok({ success: true }); } }),
      files: {
        ...base.files,
        writeFile: async () => { throw new Error('disk full'); },
      } as typeof base.files,
    });
    await expect(runExport(d, opts)).rejects.toThrow('disk full');
    expect(completeCalled).toBe(false);
  });

  it('excludes a persistently failing media object without failing the export', async () => {
    const d = deps({ binaryGet: async () => { throw new Error('boom'); } });
    const result = await runExport(d, opts);
    expect(result.excluded.some((e) => e.class === 'bad_media')).toBe(true);
    expect(result.media).toBe(0);
  });
});

describe('runExport resume of completed tables', () => {
  it('reuses published shard bytes and per-shard row counts instead of re-reading', async () => {
    const files = new Map<string, Uint8Array>();
    // Two shards of a completed table, written by a prior run.
    files.set(join('/out', 'job-123', 'data', 'inspections.ndjson'), new TextEncoder().encode('{"id":1}\n'));
    files.set(join('/out', 'job-123', 'data', 'inspections.2.ndjson'), new TextEncoder().encode('{"id":2}\n'));
    const fs: ExportFs = {
      async mkdir() {},
      async writeFile(p, d) { files.set(p, Uint8Array.from(d)); },
      async readFile(p) { const v = files.get(p); if (!v) throw new Error('missing ' + p); return v; },
      async rename(o, n) { const v = files.get(o); if (!v) throw new Error('missing'); files.delete(o); files.set(n, v); },
    };
    let rowsCalls = 0;
    const http = fakeHttp({ rows: () => { rowsCalls++; throw new Error('rows endpoint must not be called for a completed table'); } });
    const checkpoint: JobCheckpoint = {
      jobId: 'job-123', kind: 'export', deviceLabel: 'DESKTOP-1', snapshotAt: 1700000000000,
      stage: 'media',
      tables: { inspections: {
        cursor: null, rows: 2, bytes: 18,
        shards: ['data/inspections.ndjson', 'data/inspections.2.ndjson'], shardRows: [1, 1],
      } },
      counts: { rows: 2, media: 0 }, bytes: 18,
      meta: { schemaFingerprint: 'a'.repeat(64), serverVersion: '2.6.0' }, updatedAt: 1700000000000,
    };
    const d = deps({ state: memState(checkpoint), files: fs, http });
    const result = await runExport(d, opts);
    expect(rowsCalls).toBe(0);
    expect(result.rows).toBe(2);
    expect(result.selfCheck.ok).toBe(true);
  });
});

describe('runExport against a real filesystem', () => {
  it('creates subdirectories, writes a root package.zip and round-trips', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dp-export-fs-'));
    try {
      const realFs: ExportFs = {
        async mkdir(p) { mkdirSync(p, { recursive: true }); },
        async writeFile(p, data) { writeFileSync(p, data); },
        async readFile(p) { return new Uint8Array(readFileSync(p)); },
        async rename(o, n) { rmSync(n, { force: true }); writeFileSync(n, readFileSync(o)); rmSync(o); },
      };
      const d = deps({ files: realFs, baseDir: root });
      const result = await runExport(d, opts);
      const { existsSync } = await import('node:fs');
      // The root volume must exist as a single package.zip, plus the manifest
      // copy the offline verifier reads first.
      expect(existsSync(join(result.outputDir, 'package.zip'))).toBe(true);
      expect(existsSync(join(result.outputDir, 'manifest.json'))).toBe(true);
      expect(result.selfCheck.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
