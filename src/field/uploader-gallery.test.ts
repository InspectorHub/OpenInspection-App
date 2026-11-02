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
  it('is requested once, for the row that was just stored', async () => {
    const w = await createUploaderWorld();
    const seen: Array<{ pendingId: string; row: boolean }> = [];
    const factory = createUploaderFactory({
      ...w.deps,
      copyToGallery: async (rec) => {
        seen.push({ pendingId: rec.pendingId, row: (await w.world.store.getRow(rec.pendingId)) !== null });
      },
    });
    const result = await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([{ pendingId: 'p1', row: true }]);
  });

  it('is not waited for: a copy that never finishes (the iOS permission prompt, unanswered) does not hold up the entry or the upload', async () => {
    const w = await createUploaderWorld();
    const factory = createUploaderFactory({ ...w.deps, copyToGallery: () => new Promise<void>(() => undefined) });
    const result = await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result.ok).toBe(true);
    expect(w.nativeCalls).toEqual(['p1']);
    expect(photosOf(w.doc, FK)).toHaveLength(1);
  });

  it('is asked for the photo as it will be stored, so the copy is the same bytes', async () => {
    const w = await createUploaderWorld();
    const bytes: number[] = [];
    const factory = createUploaderFactory({ ...w.deps, copyToGallery: async (rec: Photo) => { bytes.push(rec.blob.size); } });
    await factory(INSPECTION, null).upload(photoRecord('p1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bytes).toEqual([photoRecord('p1').blob.size]);
  });

  it('a copier that rejects changes nothing about the upload: the photo is still uploaded and named in the document', async () => {
    const w = await createUploaderWorld();
    const factory = createUploaderFactory({ ...w.deps, copyToGallery: () => Promise.reject(new Error('gallery full /secret')) });
    const result = await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result.ok).toBe(true);
    expect(w.nativeCalls).toEqual(['p1']);
    expect(photosOf(w.doc, FK)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.errors).toHaveLength(1);
  });

  it('is not requested for a row the editor queued earlier (its copy is the editor\'s), nor when the device store refuses the photo', async () => {
    const w = await createUploaderWorld();
    let copies = 0;
    const copy = { copyToGallery: () => { copies += 1; return Promise.resolve(); } };
    await w.world.store.put(photoRecord('queued'));
    const [queued] = await w.world.store.list(INSPECTION);
    await createUploaderFactory({ ...w.deps, ...copy })(INSPECTION, null).upload(queued as PendingMediaRecord);
    await new Promise((resolve) => setTimeout(resolve, 0));
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
