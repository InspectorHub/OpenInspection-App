import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { INSPECTION, jpegBlob, photoRecord } from '../media/test-support/fakes';
import { MAX_MEDIA_BYTES } from '../media/store';
import { MESSAGES } from './messages';
import { seedPhotos } from './test-support/doc-seed';
import { reply, scriptedApi } from './test-support/scripted-api';
import { createUploaderWorld } from './test-support/uploader-world';
import { createStoredBlobReader, createUploaderFactory, type UploaderDeps } from './uploader';

const keyFor = (pendingId: string): string => `tenant-1/inspections/${INSPECTION}/photos/${pendingId}.jpg`;
type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;

const itemPhoto = (pendingId: string, over: Partial<Photo> = {}): PendingMediaRecord => ({ ...photoRecord(pendingId), ...over });

const cropRecord = (pendingId: string): PendingMediaRecord => ({
  kind: 'crop',
  pendingId,
  inspectionId: INSPECTION,
  blob: jpegBlob(3),
  createdAt: 5,
  meta: { findingKey: '_default:s1:i1', itemId: 'i1', photoIndex: 0, photoKey: 'photo-b', crop: { aspect: 'free', orientation: 'landscape', x: 0, y: 0, width: 4, height: 4 } },
});

const annotateRecord = (pendingId: string): PendingMediaRecord => ({
  kind: 'annotate',
  pendingId,
  inspectionId: INSPECTION,
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  createdAt: 6,
  meta: { findingKey: '_default:s1:i1', itemId: 'i1', photoIndex: 0, photoKey: 'photo-b', nodesJson: '[]' },
});

const defectRecord = (pendingId: string): PendingMediaRecord => ({
  kind: 'photo',
  pendingId,
  inspectionId: INSPECTION,
  blob: jpegBlob(4),
  createdAt: 7,
  meta: { targetType: 'defect', findingKey: '_default:s1:i1', itemId: 'i1', customId: 'c1', defectKind: 'custom' },
});

function docWithPhoto(): Y.Doc {
  const doc = new Y.Doc();
  seedPhotos(doc, '_default:s1:i1', [{ key: 'photo-a' }, { key: 'photo-b' }]);
  return doc;
}

describe('item photo (the online path)', () => {
  it('stores the photo, uploads it through the background uploader once, answers the key and leaves nothing on the device', async () => {
    const w = await createUploaderWorld();
    const result = await w.factory(INSPECTION, null).upload(itemPhoto('p1'));
    expect(result).toEqual({ ok: true, key: keyFor('p1') });
    expect(w.nativeCalls).toEqual(['p1']);
    expect(w.world.engine.objects.has(keyFor('p1'))).toBe(true);
    expect(await w.world.store.listRows()).toEqual([]);
    expect(w.world.files.paths()).toEqual([]);
    expect(w.api.calls).toHaveLength(0);
  });

  it('a failed upload answers a sentence and still removes the row: the person retries, the reconciler never sends it behind their back', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const result = await w.factory(INSPECTION, null).upload(itemPhoto('p1'));
    expect(result).toEqual({ ok: false, error: MESSAGES.unreachable });
    expect(await w.world.store.listRows()).toEqual([]);
    expect(w.world.files.paths()).toEqual([]);
  });

  it('control: a row the uploader did NOT create (the editor queued it) is neither created again nor deleted by a success', async () => {
    const w = await createUploaderWorld();
    await w.world.store.put(photoRecord('p1'));
    const [listed] = await w.world.store.list(INSPECTION);
    expect(listed?.blob.size).toBe(0);
    const result = await w.factory(INSPECTION, null).upload(listed as PendingMediaRecord);
    expect(result).toEqual({ ok: true, key: keyFor('p1') });
    // The package swaps the document and deletes the record itself, in that order. Deleting here would come first.
    const rows = await w.world.store.listRows();
    expect(rows.map((row) => [row.pendingId, row.state])).toEqual([['p1', 'uploaded']]);
  });

  it('a queued row whose upload fails stays queued for the next drain', async () => {
    const w = await createUploaderWorld();
    await w.world.store.put(photoRecord('p1'));
    w.plugin.defaultBehavior = { kind: 'fail' };
    const [listed] = await w.world.store.list(INSPECTION);
    expect((await w.factory(INSPECTION, null).upload(listed as PendingMediaRecord)).ok).toBe(false);
    expect((await w.world.store.listRows()).map((row) => row.pendingId)).toEqual(['p1']);
  });

  it('refuses what the engine would refuse, with a sentence, and stores nothing', async () => {
    const w = await createUploaderWorld();
    const big = await w.factory(INSPECTION, null).upload(itemPhoto('p1', { blob: jpegBlob(1, MAX_MEDIA_BYTES + 1) }));
    expect(big).toEqual({ ok: false, error: MESSAGES.photoTooLarge });
    const gif = await w.factory(INSPECTION, null).upload(itemPhoto('p2', { blob: jpegBlob(1, 64, 'image/gif') }));
    expect(gif).toEqual({ ok: false, error: MESSAGES.photoTypeUnsupported });
    const empty = await w.factory(INSPECTION, null).upload(itemPhoto('p3', { blob: new Blob([], { type: 'image/jpeg' }) }));
    expect(empty).toEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(await w.world.store.listRows()).toEqual([]);
    expect(w.nativeCalls).toEqual([]);
  });

  it('two uploads of one photo (the drain and the reconciler) send the bytes once', async () => {
    const w = await createUploaderWorld();
    const uploader = w.factory(INSPECTION, null);
    const [a, b] = await Promise.all([uploader.upload(itemPhoto('p1')), uploader.upload(itemPhoto('p1'))]);
    expect(a).toEqual({ ok: true, key: keyFor('p1') });
    expect(b).toEqual({ ok: true, key: keyFor('p1') });
    expect(w.plugin.starts).toHaveLength(1);
  });

  it('a record of another inspection is refused', async () => {
    const w = await createUploaderWorld();
    const result = await w.factory('insp-other', null).upload(itemPhoto('p1'));
    expect(result).toEqual({ ok: false, error: MESSAGES.unavailable });
    expect(await w.world.store.listRows()).toEqual([]);
  });
});

describe('a blocked inspection', () => {
  it('uploads nothing, stores nothing, and says so', async () => {
    const w = await createUploaderWorld();
    w.blocked.add(INSPECTION);
    const uploader = w.factory(INSPECTION, docWithPhoto());
    for (const rec of [itemPhoto('p1'), defectRecord('p2'), cropRecord('p3'), annotateRecord('p4')]) {
      expect(await uploader.upload(rec), rec.kind).toEqual({ ok: false, error: MESSAGES.blocked });
    }
    expect(w.nativeCalls).toEqual([]);
    expect(w.api.calls).toEqual([]);
    expect(await w.world.store.listRows()).toEqual([]);
    expect(w.plugin.starts).toHaveLength(0);
  });

  it('control: the same calls go out when the inspection is not blocked', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { key: 'k' } })) });
    expect((await w.factory(INSPECTION, null).upload(itemPhoto('p1'))).ok).toBe(true);
    expect((await w.factory(INSPECTION, null).upload(defectRecord('p2'))).ok).toBe(true);
    expect(w.nativeCalls).toEqual(['p1']);
    expect(w.api.calls).toHaveLength(1);
  });

  it('keeps the row when the block begins during the upload: quarantine owns it then', async () => {
    const w = await createUploaderWorld();
    const stubNative: UploaderDeps['native'] = {
      uploadDetailed: () => {
        w.blocked.add(INSPECTION);
        return Promise.resolve({ ok: false, code: 'BLOCKED', retryable: false, retryAfterMs: null, halt: false });
      },
    };
    const factory = createUploaderFactory({ ...w.deps, native: stubNative });
    expect(await factory(INSPECTION, null).upload(itemPhoto('p1'))).toEqual({ ok: false, error: MESSAGES.blocked });
    expect((await w.world.store.listRows()).map((row) => row.pendingId)).toEqual(['p1']);
  });
});

describe('defect photo', () => {
  it('goes to the foreground upload and never touches the device store or the background uploader', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { success: true, data: { key: 'defect-key' } })) });
    expect(await w.factory(INSPECTION, null).upload(defectRecord('p1'))).toEqual({ ok: true, key: 'defect-key' });
    expect(w.nativeCalls).toEqual([]);
    expect(await w.world.store.listRows()).toEqual([]);
    expect(w.api.calls).toHaveLength(1);
    expect(w.api.calls[0]?.path).toBe(`/api/inspections/${INSPECTION}/upload`);
  });
});

describe('crop and annotate never reach the background uploader', () => {
  it('a crop is sent to the crop route once and the uploader is not asked (control: the same photo as a plain photo is asked exactly once)', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { croppedKey: 'cropped-key' } })) });
    const uploader = w.factory(INSPECTION, docWithPhoto());
    expect(await uploader.upload(cropRecord('p1'))).toEqual({ ok: true, key: 'cropped-key' });
    expect(w.nativeCalls).toEqual([]);
    expect(w.api.calls.map((call) => call.path)).toEqual([`/api/inspections/${INSPECTION}/items/i1/photos/1/crop`]);
    expect(await w.world.store.listRows()).toEqual([]);

    expect((await uploader.upload(itemPhoto('p2'))).ok).toBe(true);
    expect(w.nativeCalls).toEqual(['p2']);
  });

  it('an annotation is sent to the annotation route once and the uploader is not asked', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { annotatedKey: 'ann-key' } })) });
    expect(await w.factory(INSPECTION, docWithPhoto()).upload(annotateRecord('p1'))).toEqual({ ok: true, key: 'ann-key' });
    expect(w.nativeCalls).toEqual([]);
    expect(w.api.calls.map((call) => call.path)).toEqual([`/api/inspections/${INSPECTION}/items/i1/photos/1/annotation`]);
  });

  it('a queued crop row is read back from the device, sent, and not marked failed or deleted', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { croppedKey: 'cropped-key' } })) });
    await w.world.store.put(cropRecord('p1'));
    const [listed] = await w.world.store.list(INSPECTION);
    expect(listed?.kind).toBe('crop');
    expect(listed?.blob.size).toBe(0);
    expect(await w.factory(INSPECTION, docWithPhoto()).upload(listed as PendingMediaRecord)).toEqual({ ok: true, key: 'cropped-key' });
    expect(w.nativeCalls).toEqual([]);
    const sent = w.api.calls[0]?.form?.get('image');
    expect(sent instanceof Blob && sent.size).toBeGreaterThan(0);
    expect((await w.world.store.listRows()).map((row) => [row.pendingId, row.state, row.attempts])).toEqual([['p1', 'pending', 0]]);
  });

  it('a crop whose photo is gone, or without a document, answers a failure and sends nothing', async () => {
    const w = await createUploaderWorld();
    const gone = new Y.Doc();
    seedPhotos(gone, '_default:s1:i1', [{ key: 'photo-a' }]);
    expect(await w.factory(INSPECTION, gone).upload(cropRecord('p1'))).toEqual({ ok: false, error: MESSAGES.photoGone });
    expect((await w.factory(INSPECTION, null).upload(annotateRecord('p2'))).ok).toBe(false);
    expect(w.api.calls).toHaveLength(0);
    expect(w.nativeCalls).toEqual([]);
  });
});

describe('crop and annotate wait for the document to catch up with the server', () => {
  it('refused with no request while the document is ahead; sent once it has caught up', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { croppedKey: 'cropped-key' } })) });
    w.sync.value = false;
    const uploader = w.factory(INSPECTION, docWithPhoto());
    expect(await uploader.upload(cropRecord('p1'))).toEqual({ ok: false, error: MESSAGES.waitForSync });
    expect(await uploader.upload(annotateRecord('p2'))).toEqual({ ok: false, error: MESSAGES.waitForSync });
    expect(w.api.calls).toHaveLength(0);
    w.sync.value = true;
    expect((await uploader.upload(cropRecord('p1'))).ok).toBe(true);
    expect(w.api.calls).toHaveLength(1);
  });
});

describe('a record under an id that already has a row', () => {
  it('a row of another inspection, or of another kind, is never uploaded or removed under this record', async () => {
    const other = await createUploaderWorld();
    await other.world.store.put({ ...photoRecord('p1'), inspectionId: 'insp-other' });
    expect(await other.factory(INSPECTION, null).upload(itemPhoto('p1'))).toEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    const kind = await createUploaderWorld();
    await kind.world.store.put(cropRecord('p1'));
    expect(await kind.factory(INSPECTION, null).upload(itemPhoto('p1'))).toEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(other.nativeCalls).toEqual([]);
    expect(kind.nativeCalls).toEqual([]);
    expect((await other.world.store.listRows()).map((row) => row.pendingId)).toEqual(['p1']);
    expect((await kind.world.store.listRows()).map((row) => row.kind)).toEqual(['crop']);
  });
});

type Code = 'AUTH' | 'LOCKED' | 'UPGRADE' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK' | 'REJECTED' | 'FILE';
const failedWith = (code: Code) => ({ ok: false as const, code, retryable: true, retryAfterMs: null, halt: false });

describe('what the person is told for each way the background upload can end', () => {
  const codes: [Code, string][] = [
    ['AUTH', MESSAGES.sessionExpired],
    ['LOCKED', MESSAGES.deviceLocked],
    ['UPGRADE', MESSAGES.upgradeRequired],
    ['TOO_LARGE', MESSAGES.photoTooLarge],
    ['TIMEOUT', MESSAGES.unreachable],
    ['NETWORK', MESSAGES.unreachable],
    ['REJECTED', MESSAGES.photoUploadFailed],
    ['FILE', MESSAGES.photoUploadFailed],
  ];
  it.each(codes)('%s', async (code, sentence) => {
    const w = await createUploaderWorld();
    const factory = createUploaderFactory({ ...w.deps, native: { uploadDetailed: () => Promise.resolve(failedWith(code)) } });
    expect(await factory(INSPECTION, null).upload(itemPhoto('p1'))).toEqual({ ok: false, error: sentence });
  });

  it('a record of a kind this build does not know is refused without anything being sent', async () => {
    const w = await createUploaderWorld();
    const odd = { ...itemPhoto('p1'), kind: 'sketch' } as unknown as PendingMediaRecord;
    expect(await w.factory(INSPECTION, null).upload(odd)).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(w.nativeCalls).toEqual([]);
    expect(w.api.calls).toEqual([]);
  });
});

describe('the stored blob reader', () => {
  it('hands back the bytes with the type the row was stored under', async () => {
    const w = await createUploaderWorld();
    await w.world.store.put(photoRecord('p1', { type: 'image/png' }));
    const blob = await createStoredBlobReader(w.world.store, w.world.files)('p1');
    expect(blob?.type).toBe('image/png');
    expect(blob?.size).toBe(64);
  });

  it('a missing row or a file that cannot be read is null, and a crop that needs it sends nothing', async () => {
    const w = await createUploaderWorld();
    const reader = createStoredBlobReader(w.world.store, w.world.files);
    expect(await reader('absent')).toBeNull();
    await w.world.store.put(cropRecord('p1'));
    w.world.files.failReadFor('media/p1.jpg');
    expect(await reader('p1')).toBeNull();
    const [listed] = await w.world.store.list(INSPECTION);
    expect(await w.factory(INSPECTION, docWithPhoto()).upload(listed as PendingMediaRecord)).toEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(w.api.calls).toEqual([]);
  });
});

describe('it never throws', () => {
  it('a background uploader that throws becomes a sentence and does not leave the row behind', async () => {
    const w = await createUploaderWorld();
    const throwing: UploaderDeps['native'] = { uploadDetailed: () => Promise.reject(new Error('plugin exploded at /secret/path')) };
    const factory = createUploaderFactory({ ...w.deps, native: throwing });
    const result = await factory(INSPECTION, null).upload(itemPhoto('p1'));
    expect(result).toEqual({ ok: false, error: MESSAGES.requestFailed });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('a store that fails to write answers a sentence', async () => {
    const w = await createUploaderWorld();
    w.world.files.failWrites();
    const result = await w.factory(INSPECTION, null).upload(itemPhoto('p1'));
    expect(result).toEqual({ ok: false, error: MESSAGES.photoNotPrepared });
  });

  it('a row that cannot be removed is reported but the upload still succeeded', async () => {
    const w = await createUploaderWorld();
    const stuck: UploaderDeps['store'] = { ...w.world.store, getRow: (id) => w.world.store.getRow(id), put: (rec) => w.world.store.put(rec), delete: () => Promise.reject(new Error('disk')) };
    const factory = createUploaderFactory({ ...w.deps, store: stuck });
    expect(await factory(INSPECTION, null).upload(itemPhoto('p1'))).toEqual({ ok: true, key: keyFor('p1') });
    expect(w.errors).toHaveLength(1);
  });
});
