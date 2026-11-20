import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  FORMAT_VERSION, ROOT_VOLUME_NAME, dataFileName, generateChecksums,
  serializeManifest, sha256Hex, type ChecksumEntry, type Manifest,
} from '@inspectorhub/data-package';
import { runImport, runRevert, type ImportRunnerDeps } from './importer';
import { dataPackageEndpoints } from './config';
import type { DataPackageStateHost, JobCheckpoint } from './state';
import type { DataPackageHttp, DataPackageResponse } from './http';

const ORIGIN = 'https://engine.test';
const EP = dataPackageEndpoints(ORIGIN);
const ok = (json: unknown): DataPackageResponse => ({ status: 200, text: JSON.stringify(json), json, budget: null, retryAfterMs: null });

async function makePackage(): Promise<Uint8Array> {
    const dataPath = dataFileName('contacts', 1);
    const dataText = '{"id":"c1","tenant_id":"src","name":"A"}\n';
    const dataBytes = strToU8(dataText);
    const mediaText = '';
    const manifest: Manifest = {
        formatVersion: FORMAT_VERSION, schemaVersion: '0013_import_id_map', columnFingerprint: 'a'.repeat(64),
        engineVersion: '2.6.0', packageId: '123e4567-e89b-12d3-a456-426614174000',
        exportedAt: '2026-01-01T00:00:00.000Z', sourceMode: 'standalone', sourceTenantId: 'src',
        sourceHost: null, encryption: null, counts: { contacts: 1 },
        media: { count: 0, index: { path: 'media/index.ndjson', bytes: 0, sha256: await sha256Hex(strToU8(mediaText)) } },
        files: [{ path: dataPath, volume: ROOT_VOLUME_NAME, rows: 1, bytes: dataBytes.length, sha256: await sha256Hex(dataBytes) }],
        volumes: [], excluded: [],
    };
    const checksums: ChecksumEntry[] = [
        { path: 'media/index.ndjson', sha256: manifest.media.index.sha256 },
        ...manifest.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    ];
    return zipSync({
        'manifest.json': serializeManifest(manifest),
        'checksums.sha256': strToU8(generateChecksums(checksums)),
        'media/index.ndjson': strToU8(mediaText),
        [dataPath]: dataBytes,
    });
}

function memState(initial: JobCheckpoint | null = null): DataPackageStateHost & { saves: number; cleared: boolean } {
    return {
        saves: 0, cleared: false,
        async load() { return initial; },
        async save() { this.saves++; },
        async clear() { this.cleared = true; },
    };
}

function fakeHttp(log: string[]): DataPackageHttp {
    return {
        async request(req) {
            const p = new URL(req.url).pathname;
            log.push(`${req.method} ${p}`);
            if (p === '/api/admin/data-package/jobs' && req.method === 'POST') {
                return ok({ success: true, data: { jobId: 'job-1', jobToken: 'tok-1' } });
            }
            if (p.endsWith('/import/preflight')) return ok({ success: true, data: { ok: true, reasons: [], advisories: [], estimate: {} } });
            if (p.endsWith('/import/plan')) return ok({ success: true, data: { tiers: [['contacts']] } });
            if (p.endsWith('/import/batches')) {
                const body = JSON.parse(String(req.body)) as { table: string; rows: unknown[] };
                return ok({ success: true, data: { created: { [body.table]: body.rows.length }, skipped: {}, rejected: [] } });
            }
            if (p.endsWith('/import/archive')) return ok({ success: true, data: { ok: true, verdict: { problems: [] } } });
            if (p.endsWith('/complete')) return ok({ success: true, data: {} });
            if (p.endsWith('/resume')) return ok({ success: true, data: { jobToken: 'tok-2' } });
            if (p.endsWith('/revert/step')) {
                const n = log.filter((l) => l.includes('/revert/step')).length;
                return ok({ success: true, data: { done: n >= 2, processed: 1, deleted: {}, kept: [], mediaDeleted: 0, errors: [] } });
            }
            throw new Error('unexpected ' + p);
        },
    };
}

async function deps(over: Partial<ImportRunnerDeps> = {}, log: string[] = []): Promise<ImportRunnerDeps> {
    const pkg = await makePackage();
    return {
        http: fakeHttp(log), endpoints: EP, bearer: 'bearer-secret', state: memState(),
        now: () => 1700000000000, sleep: async () => {}, log: () => {},
        readPackage: async () => pkg, readVolume: async () => undefined,
        stepUp: async (action) => `stepup-${action}`,
        ...over,
    };
}

describe('runImport', () => {
    it('verifies locally then applies the plan tier by tier and completes', async () => {
        const log: string[] = [];
        const result = await runImport(await deps({}, log), {
            deviceLabel: 'desk-1', clientKind: 'windows',
        });
        expect(result.jobId).toBe('job-1');
        expect(result.applied.contacts).toBe(1);
        expect(result.rejected).toEqual([]);
        expect(result.mediaUploaded).toBe(0);
        expect(result.archiveOk).toBe(false); // fixture has no esign files
        expect(result.preview.counts).toEqual({ contacts: 1 });
        expect(log.some((l) => l.includes('/import/preflight'))).toBe(true);
        expect(log.some((l) => l.includes('/import/batches'))).toBe(true);
        expect(log.some((l) => l.includes('/complete'))).toBe(true);
        // preflight and plan come before batches; complete comes last
        expect(log.indexOf(log.find((l) => l.includes('/complete'))!)).toBeGreaterThan(
            log.indexOf(log.find((l) => l.includes('/import/batches'))!),
        );
    });

    it('mints a fresh, action-scoped step-up token for each privileged call', async () => {
        const minted: string[] = [];
        let n = 0;
        const d = await deps({}, []);
        const d2: ImportRunnerDeps = {
            ...d,
            stepUp: async (action) => { const t = `${action}-${++n}`; minted.push(t); return t; },
        };
        await runImport(d2, { deviceLabel: 'desk-1', clientKind: 'windows' });
        // create-job uses data-export-start; batches/media/archive each use a
        // DISTINCT data-import-apply token (engine tokens are single-use).
        expect(minted[0]).toBe('data-export-start-1');
        expect(minted.filter((t) => t.startsWith('data-import-apply-')).length).toBeGreaterThan(0);
        expect(new Set(minted).size).toBe(minted.length); // no token reused
    });

    it('refuses a package that fails local verification before any request', async () => {
        const log: string[] = [];
        await expect(runImport(await deps({ readPackage: async () => strToU8('garbage') }, log), {
            deviceLabel: 'desk-1', clientKind: 'windows',
        })).rejects.toThrow(/package-invalid/);
        expect(log).toHaveLength(0);
    });

    it('resumes an existing import job via the resume endpoint', async () => {
        const existing: JobCheckpoint = {
            jobId: 'job-old', kind: 'import', deviceLabel: 'desk-1', snapshotAt: 0,
            stage: 'apply', tables: {}, counts: { rows: 0, media: 0 }, bytes: 0,
            meta: { schemaFingerprint: '', serverVersion: '' }, updatedAt: 0,
        };
        const log: string[] = [];
        const d = await deps({ state: memState(existing) }, log);
        const result = await runImport(d, { deviceLabel: 'desk-1', clientKind: 'windows' });
        expect(result.jobId).toBe('job-old');
        expect(log.some((l) => l.includes('/resume'))).toBe(true);
        // No job creation: the only POST to the bare .../jobs path is absent.
        expect(log.some((l) => l === 'POST /api/admin/data-package/jobs')).toBe(false);
    });
});

describe('runRevert', () => {
    it('loops until done, minting a fresh step-up token each step', async () => {
        const log: string[] = [];
        const d = await deps({}, log);
        let issued = 0;
        const result = await runRevert(d, 'job-1', 'tok-1', async () => `step-${++issued}`);
        expect(result.done).toBe(true);
        expect(result.step).toBe(2);
        expect(issued).toBe(2);
        expect(log.filter((l) => l.includes('/revert/step'))).toHaveLength(2);
    });
});
