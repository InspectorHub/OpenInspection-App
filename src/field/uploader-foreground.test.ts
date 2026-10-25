import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { MAX_MEDIA_BYTES } from '../media/store';
import { MESSAGES } from './messages';
import { seedPhotos } from './test-support/doc-seed';
import { formFields, reply, scriptedApi } from './test-support/scripted-api';
import { createForegroundUploads } from './uploader-foreground';

type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;
type Crop = Extract<PendingMediaRecord, { kind: 'crop' }>;
type Annotate = Extract<PendingMediaRecord, { kind: 'annotate' }>;

const bytes = (n = 8, type = 'image/jpeg'): Blob => new Blob([new Uint8Array(n).fill(7)], { type });
const FINDING = '_default:s1:i1';

const defectRec = (over: Partial<Photo> = {}): Photo => ({
  kind: 'photo',
  pendingId: 'pend-1',
  inspectionId: 'insp-1',
  blob: bytes(),
  createdAt: 1,
  meta: { targetType: 'defect', findingKey: FINDING, itemId: 'i1', customId: 'cust-1', defectKind: 'custom' },
  ...over,
});

const cropRec = (over: Partial<Crop['meta']> = {}, blob: Blob = bytes()): Crop => ({
  kind: 'crop',
  pendingId: 'pend-2',
  inspectionId: 'insp-1',
  blob,
  createdAt: 1,
  meta: { findingKey: FINDING, itemId: 'i1', photoIndex: 0, photoKey: 'photo-b', crop: { aspect: '3:2', orientation: 'landscape', x: 1, y: 2, width: 30, height: 20 }, ...over },
});

const annotateRec = (over: Partial<Annotate['meta']> = {}, blob: Blob = bytes(8, 'image/png')): Annotate => ({
  kind: 'annotate',
  pendingId: 'pend-3',
  inspectionId: 'insp-1',
  blob,
  createdAt: 1,
  meta: { findingKey: FINDING, itemId: 'i1', photoIndex: 0, photoKey: 'photo-b', nodesJson: '[{"t":"arrow"}]', ...over },
});

function docWith(...keys: string[]): Y.Doc {
  const doc = new Y.Doc();
  seedPhotos(doc, FINDING, keys.map((key) => ({ key })));
  return doc;
}

function setup(answers: Parameters<typeof scriptedApi>, stored: Blob | null = null) {
  const sync = { value: true };
  const api = scriptedApi(...answers);
  const reads: string[] = [];
  const fg = createForegroundUploads({
    api,
    readStoredBlob: (id) => {
      reads.push(id);
      return Promise.resolve(stored);
    },
    isSynced: () => sync.value,
  });
  return { api, fg, reads, sync };
}

describe('defect photo', () => {
  it('posts the multipart upload with exactly the fields the web action sends and answers the stored key', async () => {
    const { api, fg } = setup([reply(200, { success: true, data: { key: 't/inspections/insp-1/photos/x.jpg', targetType: 'defect', itemId: 'i1', customId: 'cust-1' } })]);
    expect(await fg.defectPhoto(defectRec())).toEqual({ ok: true, key: 't/inspections/insp-1/photos/x.jpg' });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/insp-1/upload', idempotencyKey: 'pend-1' });
    expect(formFields(api.calls[0]?.form)).toEqual({ file: 'file:photo.jpg', itemId: 'i1', targetType: 'defect', customId: 'cust-1' });
  });

  it('an item photo record is not this path: it is refused without a request (control: the defect record above is sent)', async () => {
    const { api, fg } = setup([]);
    const item: Photo = { ...defectRec(), meta: { targetType: 'item', findingKey: FINDING, itemId: 'i1' } };
    const result = await fg.defectPhoto(item);
    expect(result.ok).toBe(false);
    expect(api.calls).toHaveLength(0);
  });

  it('refuses a photo the server would refuse, before any request', async () => {
    const big = setup([]);
    expect(await big.fg.defectPhoto(defectRec({ blob: bytes(MAX_MEDIA_BYTES + 1) }))).toEqual({ ok: false, error: MESSAGES.photoTooLarge });
    const odd = setup([]);
    expect(await odd.fg.defectPhoto(defectRec({ blob: bytes(8, 'image/gif') }))).toEqual({ ok: false, error: MESSAGES.photoTypeUnsupported });
    const empty = setup([]);
    expect(await empty.fg.defectPhoto(defectRec({ blob: new Blob([], { type: 'image/jpeg' }) }))).toEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect([big, odd, empty].map((s) => s.api.calls.length)).toEqual([0, 0, 0]);
  });

  it('says what happened for each way the answer can fail', async () => {
    const cases: [Parameters<typeof scriptedApi>[0], string][] = [
      [reply(200, { success: true, data: {} }), MESSAGES.unreadableAnswer],
      [reply(413), MESSAGES.photoTooLarge],
      [reply(403), MESSAGES.forbidden],
      [reply(500, { error: { message: 'secret internals' } }), MESSAGES.photoUploadFailed],
      [{ kind: 'problem', problem: 'unknown' }, MESSAGES.outcomeUnknown],
      [{ kind: 'problem', problem: 'offline' }, MESSAGES.needsConnection],
      [{ kind: 'problem', problem: 'locked' }, MESSAGES.deviceLocked],
      [{ kind: 'problem', problem: 'auth' }, MESSAGES.sessionExpired],
      [{ kind: 'problem', problem: 'upgrade' }, MESSAGES.upgradeRequired],
      [{ kind: 'problem', problem: 'server_too_old' }, MESSAGES.serverTooOld],
    ];
    for (const [answer, sentence] of cases) {
      const { fg } = setup([answer]);
      expect(await fg.defectPhoto(defectRec()), sentence).toEqual({ ok: false, error: sentence });
    }
  });
});

describe('crop', () => {
  it('re-resolves the photo position from the document at upload time, not from the queued index', async () => {
    const doc = docWith('photo-a', 'photo-b');
    const { api, fg } = setup([reply(200, { success: true, data: { croppedKey: 't/inspections/insp-1/photos/c.jpg' } })]);
    expect(await fg.crop(cropRec({ photoIndex: 0, sectionId: 's1' }), doc)).toEqual({ ok: true, key: 't/inspections/insp-1/photos/c.jpg' });
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/insp-1/items/i1/photos/1/crop' });
    expect(formFields(api.calls[0]?.form)).toEqual({ image: 'file:cropped.jpg', crop: JSON.stringify({ aspect: '3:2', orientation: 'landscape', x: 1, y: 2, width: 30, height: 20 }), sectionId: 's1' });
  });

  it('omits sectionId when the record has none', async () => {
    const { api, fg } = setup([reply(200, { data: { croppedKey: 'k' } })]);
    await fg.crop(cropRec(), docWith('photo-b'));
    expect(Object.keys(formFields(api.calls[0]?.form))).toEqual(['image', 'crop']);
  });

  it('the photo being gone, or there being no document, fails without a request', async () => {
    const gone = setup([]);
    expect(await gone.fg.crop(cropRec({ photoKey: 'removed' }), docWith('photo-a', 'photo-b'))).toEqual({ ok: false, error: MESSAGES.photoGone });
    const noDoc = setup([]);
    expect((await noDoc.fg.crop(cropRec(), null)).ok).toBe(false);
    const rebuilt = setup([reply(200, { data: { croppedKey: 'k' } })]);
    expect((await rebuilt.fg.crop(cropRec(), docWith('photo-b'))).ok).toBe(true);
    expect([gone, noDoc].map((s) => s.api.calls.length)).toEqual([0, 0]);
    expect(rebuilt.api.calls).toHaveLength(1);
  });

  it('reads the bytes from the device when the record from the queue carries none', async () => {
    const stored = bytes(12);
    const { api, fg, reads } = setup([reply(200, { data: { croppedKey: 'k' } })], stored);
    const result = await fg.crop(cropRec({}, new Blob([], { type: 'image/jpeg' })), docWith('photo-b'));
    expect(result).toEqual({ ok: true, key: 'k' });
    expect(reads).toEqual(['pend-2']);
    expect(api.calls).toHaveLength(1);
    const unreadable = setup([], null);
    expect(await unreadable.fg.crop(cropRec({}, new Blob([], { type: 'image/jpeg' })), docWith('photo-b'))).toEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(unreadable.api.calls).toHaveLength(0);
  });

  it('a crop answer without its key is not a success', async () => {
    const { fg } = setup([reply(200, { data: {} })]);
    expect(await fg.crop(cropRec(), docWith('photo-b'))).toEqual({ ok: false, error: MESSAGES.unreadableAnswer });
  });
});

describe('a position is only sent when the server counts the same photos', () => {
  it('synced, with nothing pending before the photo: the request goes out with the position counted in the document', async () => {
    const doc = docWith('photo-a', 'photo-b');
    const { api, fg } = setup([reply(200, { data: { croppedKey: 'k' } })]);
    expect((await fg.crop(cropRec(), doc)).ok).toBe(true);
    expect(api.calls[0]?.path).toBe('/api/inspections/insp-1/items/i1/photos/1/crop');
  });

  it('a document that has not caught up with the server is refused for crop and annotate, with no request', async () => {
    const doc = docWith('photo-a', 'photo-b');
    const crop = setup([reply(200, { data: { croppedKey: 'k' } })]);
    crop.sync.value = false;
    expect(await crop.fg.crop(cropRec(), doc)).toEqual({ ok: false, error: MESSAGES.waitForSync });
    const annotate = setup([reply(200, { data: { annotatedKey: 'k' } })]);
    annotate.sync.value = false;
    expect(await annotate.fg.annotate(annotateRec(), doc)).toEqual({ ok: false, error: MESSAGES.waitForSync });
    expect([crop, annotate].map((s) => s.api.calls.length)).toEqual([0, 0]);
  });

  it('a photo that is still only on this device before the target shifts the server count: refused, with no request', async () => {
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [{ key: '', pendingUpload: true, pendingId: 'p0', pendingKind: 'photo' }, { key: 'photo-b' }]);
    const crop = setup([reply(200, { data: { croppedKey: 'k' } })]);
    expect(await crop.fg.crop(cropRec(), doc)).toEqual({ ok: false, error: MESSAGES.waitForSync });
    const annotate = setup([]);
    expect(await annotate.fg.annotate(annotateRec(), doc)).toEqual({ ok: false, error: MESSAGES.waitForSync });
    expect([crop, annotate].map((s) => s.api.calls.length)).toEqual([0, 0]);
  });

  it('control: a pending photo AFTER the target does not matter', async () => {
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [{ key: 'photo-b' }, { key: '', pendingUpload: true, pendingId: 'p0', pendingKind: 'photo' }]);
    const { api, fg } = setup([reply(200, { data: { croppedKey: 'k' } })]);
    expect((await fg.crop(cropRec(), doc)).ok).toBe(true);
    expect(api.calls[0]?.path).toContain('/photos/0/crop');
  });
});

describe('annotate', () => {
  it('posts the baked image and the node tree to the annotation route at the current position', async () => {
    const doc = docWith('photo-a', 'photo-b');
    const { api, fg } = setup([reply(200, { data: { annotatedKey: 'ann-key' } })]);
    expect(await fg.annotate(annotateRec({ sectionId: 's1' }), doc)).toEqual({ ok: true, key: 'ann-key' });
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/insp-1/items/i1/photos/1/annotation' });
    expect(formFields(api.calls[0]?.form)).toEqual({ image: 'file:annotated.png', nodes: '[{"t":"arrow"}]', sectionId: 's1' });
  });

  it('fails without a request when the photo is gone or there is no document', async () => {
    const gone = setup([]);
    expect(await gone.fg.annotate(annotateRec({ photoKey: 'removed' }), docWith('photo-a'))).toEqual({ ok: false, error: MESSAGES.photoGone });
    const noDoc = setup([]);
    expect((await noDoc.fg.annotate(annotateRec(), null)).ok).toBe(false);
    expect([gone, noDoc].map((s) => s.api.calls.length)).toEqual([0, 0]);
  });

  it('refuses an item id that cannot be a path segment, without a request', async () => {
    const { api, fg } = setup([]);
    const result = await fg.annotate(annotateRec({ itemId: '../x' }), docWith('photo-b'));
    expect(result).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(api.calls).toHaveLength(0);
  });
});
