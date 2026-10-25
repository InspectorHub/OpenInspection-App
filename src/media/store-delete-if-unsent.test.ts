import { describe, expect, it } from 'vitest';
import { createMediaWorld, INSPECTION, photoRecord } from './test-support/fakes';

describe('deleteIfUnsent', () => {
  it('removes the row and the file of a pending or failed row of that inspection', async () => {
    const { store, files } = await createMediaWorld();
    await store.put(photoRecord('p1'));
    await store.put(photoRecord('p2'));
    await store.markState('p2', 'failed', { attempts: 2 });
    expect(await store.deleteIfUnsent('p1', INSPECTION)).toBe(true);
    expect(await store.deleteIfUnsent('p2', INSPECTION)).toBe(true);
    expect(await store.listRows()).toEqual([]);
    expect(files.paths()).toEqual([]);
  });

  it('keeps a row that is uploading or uploaded, and a row of another inspection', async () => {
    const { store, files } = await createMediaWorld();
    await store.put(photoRecord('up'));
    await store.put(photoRecord('done'));
    await store.put(photoRecord('other', { inspectionId: 'insp-2' }));
    await store.markState('up', 'uploading', { attempts: 0 });
    await store.markState('done', 'uploaded', { attempts: 0, uploadedKey: 'tenant-1/inspections/insp-1/photos/done.jpg' });
    expect(await store.deleteIfUnsent('up', INSPECTION)).toBe(false);
    expect(await store.deleteIfUnsent('done', INSPECTION)).toBe(false);
    expect(await store.deleteIfUnsent('other', INSPECTION)).toBe(false);
    expect((await store.listRows()).map((row) => row.pendingId).sort()).toEqual(['done', 'other', 'up']);
    expect(files.paths()).toHaveLength(3);
  });

  it('a missing row or an invalid id answers false', async () => {
    const { store } = await createMediaWorld();
    expect(await store.deleteIfUnsent('nope', INSPECTION)).toBe(false);
    expect(await store.deleteIfUnsent('../x', INSPECTION)).toBe(false);
    expect(await store.deleteIfUnsent('nope', '../x')).toBe(false);
  });

  it('a file that cannot be removed does not bring the row back', async () => {
    const { store, files } = await createMediaWorld();
    await store.put(photoRecord('p1'));
    files.failRemoveFor('media/p1.jpg');
    expect(await store.deleteIfUnsent('p1', INSPECTION)).toBe(true);
    expect(await store.listRows()).toEqual([]);
  });
});
