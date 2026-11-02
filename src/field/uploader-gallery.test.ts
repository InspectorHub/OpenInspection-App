import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { MediaError } from '../media/errors';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { photosOf } from './test-support/doc-seed';
import { createUploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory } from './uploader';

type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;
const FK = '_default:s1:i1';

describe('the copy for the gallery, made by the uploader', () => {
  it('is requested once, after the row exists and before the upload starts', async () => {
    const w = await createUploaderWorld();
    const seen: Array<{ row: boolean; uploads: number }> = [];
    const factory = createUploaderFactory({
      ...w.deps,
      copyToGallery: async (rec) => {
        seen.push({ row: (await w.world.store.getRow(rec.pendingId)) !== null, uploads: w.nativeCalls.length });
      },
    });
    const result = await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ row: true, uploads: 0 }]);
  });

  it('is asked for the photo as it will be stored, so the copy is the same bytes', async () => {
    const w = await createUploaderWorld();
    const bytes: number[] = [];
    const factory = createUploaderFactory({ ...w.deps, copyToGallery: async (rec: Photo) => { bytes.push(rec.blob.size); } });
    await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(bytes).toEqual([photoRecord('p1').blob.size]);
  });

  it('a copier that rejects changes nothing about the upload: the photo is still uploaded and named in the document', async () => {
    const w = await createUploaderWorld();
    const factory = createUploaderFactory({ ...w.deps, copyToGallery: () => Promise.reject(new Error('gallery full /secret')) });
    const result = await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result.ok).toBe(true);
    expect(w.nativeCalls).toEqual(['p1']);
    expect(photosOf(w.doc, FK)).toHaveLength(1);
    expect(w.errors).toHaveLength(1);
  });

  it('is not requested for a row the editor queued earlier (its copy is the editor\'s), nor when the device store refuses the photo', async () => {
    const w = await createUploaderWorld();
    let copies = 0;
    const copy = { copyToGallery: () => { copies += 1; return Promise.resolve(); } };
    await w.world.store.put(photoRecord('queued'));
    const [queued] = await w.world.store.list(INSPECTION);
    await createUploaderFactory({ ...w.deps, ...copy })(INSPECTION, null).upload(queued as PendingMediaRecord);
    expect(copies).toBe(0);

    const refusing = createUploaderFactory({ ...w.deps, ...copy, store: { ...w.world.store, put: () => Promise.reject(new MediaError('TOO_LARGE')) } });
    expect((await refusing(INSPECTION, null).upload(photoRecord('p2'))).ok).toBe(false);
    expect(copies).toBe(0);
  });

  it('control: without a copier the upload is exactly as before', async () => {
    const w = await createUploaderWorld();
    const result = await w.factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result.ok).toBe(true);
  });
});
