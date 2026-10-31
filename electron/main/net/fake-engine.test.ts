import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { startFakeEngine } from '../../../e2e-electron/fixtures/fake-engine.ts';

describe('Electron fake engine upload endpoints', () => {
  let engine: Awaited<ReturnType<typeof startFakeEngine>> | undefined;
  afterEach(async () => { await engine?.close(); engine = undefined; });

  it('mints a signed URL, retains the last body and counts repeated requests by key', async () => {
    engine = await startFakeEngine();
    const answer = await fetch(`${engine.url}/api/inspections/i-3/media/upload-url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pendingId: 'p-3', contentType: 'image/jpeg' }) });
    const minted = await answer.json() as { success: boolean; data: { url: string; key: string } };
    expect(minted.success).toBe(true);
    for (const body of [Buffer.from('first'), Buffer.from('second')]) {
      const uploaded = await fetch(minted.data.url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test', 'content-length': String(body.length) }, body });
      expect(uploaded.status).toBe(201);
    }
    expect(engine.uploadCounts.get(minted.data.key)).toBe(2);
    expect(engine.uploads.get(minted.data.key)).toEqual(Buffer.from('second'));
  });

  it('uses the photo extension that matches the requested content type', async () => {
    engine = await startFakeEngine();
    const answer = await fetch(`${engine.url}/api/inspections/i-png/media/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pendingId: 'p-png', contentType: 'image/png' }),
    });
    const minted = await answer.json() as { data: { key: string } };
    expect(minted.data.key).toBe('fake/inspections/i-png/photos/p-png.png');
  });

  it('answers 411 when the upload has no Content-Length', async () => {
    engine = await startFakeEngine();
    const answer = await fetch(`${engine.url}/api/inspections/i-2/media/upload-url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pendingId: 'p-2', contentType: 'image/jpeg' }) });
    const minted = await answer.json() as { data: { url: string } };
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(minted.data.url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject);
      request.write('chunked');
      request.end();
    });
    expect(status).toBe(411);
    expect(engine.uploadCounts.get('fake/inspections/i-2/photos/p-2.jpg')).toBe(1);
  });
});
