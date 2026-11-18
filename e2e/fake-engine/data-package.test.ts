/**
 * The fake engine's data-package endpoints behave like the real E-1/E-2 API
 * for the shape the desktop exporter consumes: create → tables → rows →
 * media → object → complete. These are plain-JSON routes (not in the engine's
 * native-contract subset), so this checks their values directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRendererEngine, type RendererEngine } from './engine';

let engine: RendererEngine;
beforeAll(async () => { engine = await startRendererEngine(); });
afterAll(async () => { await engine.close(); });

const AUTH = { authorization: 'Bearer renderer-access-token', 'content-type': 'application/json', 'x-data-job': 'fake-job-token' };

describe('fake engine data-package API', () => {
  it('completes the export handshake with the documented shapes', async () => {
    const base = `${engine.url}/api/admin/data-package/jobs`;

    const stepUp = await fetch(`${engine.url}/api/auth/step-up`, { method: 'POST', headers: AUTH, body: '{}' });
    const stepBody = await stepUp.json() as { data: { token?: string } };
    expect(stepUp.status).toBe(200);
    expect(typeof stepBody.data.token).toBe('string');

    const created = await fetch(base, { method: 'POST', headers: AUTH, body: JSON.stringify({ kind: 'export', clientKind: 'desktop-windows', deviceLabel: 'test' }) });
    const createBody = await created.json() as { data: { jobId: string; jobToken: string; schemaFingerprint: string } };
    expect(created.status).toBe(200);
    expect(createBody.data.jobId).toBe('dp-job-1');
    expect(createBody.data.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const tables = await fetch(`${base}/dp-job-1/tables`, { headers: AUTH });
    const tableBody = await tables.json() as { data: { table: string; rowCountAtSnapshot: number }[] };
    expect(tableBody.data[0]?.table).toBe('inspections');
    expect(tableBody.data[0]?.rowCountAtSnapshot).toBe(2);

    const rows = await fetch(`${base}/dp-job-1/tables/inspections/rows?limit=2`, { headers: AUTH });
    const rowBody = await rows.json() as { data: { rows: { id: string }[]; next: string | null } };
    expect(rowBody.data.rows).toHaveLength(2);
    expect(rowBody.data.next).toBeNull();

    const media = await fetch(`${base}/dp-job-1/media`, { headers: AUTH });
    const mediaBody = await media.json() as { data: { objects: { key: string; size: number }[] } };
    expect(mediaBody.data.objects).toHaveLength(1);

    const object = await fetch(`${base}/dp-job-1/media/object?key=${encodeURIComponent(mediaBody.data.objects[0]!.key)}`, { headers: AUTH });
    expect(object.status).toBe(200);
    expect((await object.arrayBuffer()).byteLength).toBe(mediaBody.data.objects[0]!.size);

    const heartbeat = await fetch(`${base}/dp-job-1/heartbeat`, { method: 'POST', headers: AUTH, body: '{}' });
    expect(heartbeat.status).toBe(200);

    const complete = await fetch(`${base}/dp-job-1/complete`, { method: 'POST', headers: AUTH, body: '{}' });
    expect(complete.status).toBe(200);
  });
});
