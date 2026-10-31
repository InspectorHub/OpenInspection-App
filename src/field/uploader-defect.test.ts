import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { MediaError } from '../media/errors';
import { MAX_UPLOAD_ATTEMPTS } from '../media/native-uploader';
import { defectPhotosOf, seedDefects } from './test-support/doc-seed';
import { INSPECTION, defectPhotoRecord, photoRecord } from '../media/test-support/fakes';
import { resolveDefectInDoc } from '../media/pending-doc';
import { MESSAGES } from './messages';
import { reply, scriptedApi } from './test-support/scripted-api';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory, type UploaderDeps } from './uploader';

const FK = '_default:s1:i1';
const keyFor = (pendingId: string): string => `tenant-1/inspections/${INSPECTION}/photos/${pendingId}.jpg`;
const defect = (pendingId: string, over: Parameters<typeof defectPhotoRecord>[1] = {}): PendingMediaRecord => defectPhotoRecord(pendingId, over);
const item = (pendingId: string): PendingMediaRecord => photoRecord(pendingId);

const rowStates = async (w: UploaderWorld): Promise<[string, string, number][]> => (await w.world.store.listRows()).map((row) => [row.pendingId, row.state, row.attempts]);
const resultsKeys = (w: UploaderWorld): string[] => [...w.doc.getMap<unknown>('results').keys()];

type Code = 'AUTH' | 'LOCKED' | 'UPGRADE' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK' | 'REJECTED' | 'SERVER' | 'PLUGIN' | 'STORE' | 'FILE' | 'NOT_FOUND' | 'INVALID' | 'UNSUPPORTED_KIND' | 'BLOCKED';
const stubbed = (w: UploaderWorld, code: Code, retryable = true) =>
  createUploaderFactory({ ...w.deps, native: { uploadDetailed: () => Promise.resolve({ ok: false as const, code, retryable, retryAfterMs: null, halt: false }) } });

describe('a defect photo goes through the device store and the background uploader, like an item photo', () => {
  it('stores it, uploads it under its deterministic key, answers the key and leaves nothing on the device or in the document (no foreground request)', async () => {
    const w = await createUploaderWorld();
    expect(await w.factory(INSPECTION, null).upload(defect('p1'))).toEqual({ ok: true, key: keyFor('p1') });
    expect(w.nativeCalls).toEqual(['p1']);
    expect(w.api.calls).toEqual([]);
    expect(w.world.engine.objects.has(keyFor('p1'))).toBe(true);
    expect(await rowStates(w)).toEqual([]);
    expect(w.world.files.paths()).toEqual([]);
    expect(w.docCalls).toEqual([]);
    expect(resultsKeys(w)).toEqual([]);
  });

  it('the editor attaching that same key afterwards adds it once (the key is deterministic: a second attach finds it)', async () => {
    const w = await createUploaderWorld();
    seedDefects(w.doc, FK, { custom: [{ id: 'd1' }] });
    const result = await w.factory(INSPECTION, null).upload(defect('p1', { customId: 'd1', defectKind: 'custom' }));
    if (!result.ok) throw new Error('upload failed');
    expect(resolveDefectInDoc(w.doc, { findingKey: FK, itemId: 'i1', customId: 'd1', defectKind: 'custom' }, result.key)).toBe('resolved');
    expect(resolveDefectInDoc(w.doc, { findingKey: FK, itemId: 'i1', customId: 'd1', defectKind: 'custom' }, result.key)).toBe('already');
    expect(defectPhotosOf(w.doc, FK, 'custom', 'd1')).toEqual([{ key: keyFor('p1') }]);
  });
});

describe('a failed online upload of a defect photo keeps the original and appends no document entry', () => {
  it('a transient failure keeps the row (failed, one attempt) and the file, writes nothing to the document and answers kept (control: an item photo in the same world gets its entry)', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const result = await w.factory(INSPECTION, null).upload(defect('d-1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(await rowStates(w)).toEqual([['d-1', 'failed', 1]]);
    expect(w.world.files.paths()).toEqual(['media/d-1.jpg']);
    expect(w.docCalls).toEqual([]);
    expect(resultsKeys(w)).toEqual([]);
    expect(w.api.calls).toEqual([]);
    expect(w.errors).toEqual([]);

    const itemResult = await w.factory(INSPECTION, null).upload(item('i-1'));
    expect(itemResult).toMatchObject({ ok: false, kept: true });
    expect(w.docCalls).toEqual([INSPECTION]);
    expect(resultsKeys(w)).toEqual([FK]);
  });

  it('a permanent refusal keeps the row as given up (attempts at the maximum), still without an entry', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'complete', statusCode: 422 };
    const result = await w.factory(INSPECTION, null).upload(defect('d-1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoUploadFailed, kept: true });
    expect(await rowStates(w)).toEqual([['d-1', 'failed', MAX_UPLOAD_ATTEMPTS]]);
    expect(resultsKeys(w)).toEqual([]);
  });

  it.each<[Code, string]>([
    ['LOCKED', MESSAGES.deviceLocked],
    ['AUTH', MESSAGES.sessionExpired],
    ['UPGRADE', MESSAGES.upgradeRequired],
    ['TOO_LARGE', 'TOO_LARGE'],
    ['TIMEOUT', MESSAGES.unreachable],
    ['NETWORK', MESSAGES.unreachable],
    ['REJECTED', MESSAGES.photoUploadFailed],
    ['SERVER', MESSAGES.photoUploadFailed],
    ['PLUGIN', MESSAGES.photoUploadFailed],
    ['STORE', MESSAGES.photoUploadFailed],
  ])('%s: the row stays and the answer is kept, with no entry', async (code, sentence) => {
    const w = await createUploaderWorld();
    expect(await stubbed(w, code)(INSPECTION, null).upload(defect('d-1'))).toStrictEqual({ ok: false, error: sentence, kept: true });
    expect(await rowStates(w)).toEqual([['d-1', 'pending', 0]]);
    expect(w.docCalls).toEqual([]);
  });

  it.each<[Code, boolean]>([
    ['NOT_FOUND', false],
    ['INVALID', false],
    ['UNSUPPORTED_KIND', false],
    ['FILE', false],
  ])('%s (retryable %s) leaves no bytes to keep: no kept, and the row this call created is removed', async (code, retryable) => {
    const w = await createUploaderWorld();
    const result = await stubbed(w, code, retryable)(INSPECTION, null).upload(defect('d-1'));
    expect(result.ok).toBe(false);
    expect('kept' in result).toBe(false);
    expect(await rowStates(w)).toEqual([]);
  });

  it('a block that begins during the upload keeps the row and does not say kept', async () => {
    const w = await createUploaderWorld();
    const result = await stubbed(w, 'BLOCKED', false)(INSPECTION, null).upload(defect('d-1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.blocked });
    expect(await rowStates(w)).toEqual([['d-1', 'pending', 0]]);
  });

  it('reports the kept photo as a defect photo to the notice (control: an item photo is reported as an item photo)', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const kinds: string[] = [];
    const factory = createUploaderFactory({ ...w.deps, onKept: (_id, kind) => kinds.push(kind) });
    await factory(INSPECTION, null).upload(defect('d-1'));
    await factory(INSPECTION, null).upload(item('i-1'));
    expect(kinds).toEqual(['defect', 'item']);
  });

  it('a call for a row that is already stored answers kept on a failure, writes nothing and removes nothing', async () => {
    const w = await createUploaderWorld();
    await w.world.store.put(defectPhotoRecord('d-1'));
    expect(await w.world.store.list(INSPECTION)).toEqual([]);
    w.plugin.defaultBehavior = { kind: 'fail' };
    expect(await w.factory(INSPECTION, null).upload(defect('d-1'))).toMatchObject({ ok: false, kept: true });
    expect(await rowStates(w)).toEqual([['d-1', 'failed', 1]]);
    expect(resultsKeys(w)).toEqual([]);
  });

  it('a call for a row that is already stored answers the key on a success but leaves the row: the reconciler attaches the key and removes it (control: a row this call created is removed)', async () => {
    const w = await createUploaderWorld();
    await w.world.store.put(defectPhotoRecord('d-1'));
    expect(await w.factory(INSPECTION, null).upload(defect('d-1'))).toEqual({ ok: true, key: keyFor('d-1') });
    expect(await rowStates(w)).toEqual([['d-1', 'uploaded', 0]]);
    expect(await w.factory(INSPECTION, null).upload(defect('d-2'))).toEqual({ ok: true, key: keyFor('d-2') });
    expect((await w.world.store.listRows()).map((row) => row.pendingId)).toEqual(['d-1']);
  });

  it('an id that belongs to a photo of the other sort is refused and touched in no way (and the reverse), with the same call succeeding for a fresh id', async () => {
    const w = await createUploaderWorld();
    await w.world.store.put(photoRecord('shared'));
    expect(await w.factory(INSPECTION, null).upload(defect('shared'))).toStrictEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(await rowStates(w)).toEqual([['shared', 'pending', 0]]);
    expect(w.nativeCalls).toEqual([]);

    await w.world.store.put(defectPhotoRecord('shared-d'));
    expect(await w.factory(INSPECTION, null).upload(item('shared-d'))).toStrictEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(w.nativeCalls).toEqual([]);

    expect(await w.factory(INSPECTION, null).upload(defect('fresh'))).toEqual({ ok: true, key: keyFor('fresh') });
  });
});

describe('when the device store cannot take a defect photo', () => {
  const withFailingPut = (w: UploaderWorld, error: unknown): UploaderDeps['store'] => ({ ...w.world.store, getRow: (id) => w.world.store.getRow(id), put: () => Promise.reject(error), delete: (id) => w.world.store.delete(id) });

  it.each(['WRITE_FAILED', 'DB_FAILED', 'DISK_FULL'] as const)('%s: the photo is sent once, straight to the engine with its defect, and the key is answered for the editor to attach', async (code) => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { key: 'direct-key' } })) });
    const result = await createUploaderFactory({ ...w.deps, store: withFailingPut(w, new MediaError(code)) })(INSPECTION, null).upload(defect('d-1', { customId: 'c7' }));
    expect(result).toStrictEqual({ ok: true, key: 'direct-key' });
    expect(w.api.calls).toHaveLength(1);
    expect(w.api.calls[0]?.form?.get('customId')).toBe('c7');
    expect(w.api.calls[0]?.form?.get('targetType')).toBe('defect');
    expect(w.nativeCalls).toEqual([]);
  });

  it('a policy refusal is never sent directly (control: the disk failure above is)', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { key: 'direct-key' } })) });
    const result = await createUploaderFactory({ ...w.deps, store: withFailingPut(w, new MediaError('TOO_LARGE')) })(INSPECTION, null).upload(defect('d-1'));
    expect(result).toStrictEqual({ ok: false, error: 'TOO_LARGE', permanent: true });
    expect(w.api.calls).toEqual([]);
  });
});

describe('the editor\'s own queue never sees a defect photo row', () => {
  it('a drain over what the store lists uploads the item row and leaves the defect row alone: nothing is sent twice, nothing is deleted unattached', async () => {
    const w = await createUploaderWorld();
    await w.world.store.put(photoRecord('item-1', { createdAt: 1 }));
    await w.world.store.put(defectPhotoRecord('defect-1', { createdAt: 2 }));
    // What the editor's drain does: list the inspection's records, upload each, and delete the row of each success.
    const listed = await w.world.store.list(INSPECTION);
    expect(listed.map((r) => r.pendingId)).toEqual(['item-1']);
    for (const rec of listed) {
      const sent = await w.factory(INSPECTION, null).upload(rec);
      if (sent.ok) await w.world.store.delete(rec.pendingId);
    }
    expect(w.nativeCalls).toEqual(['item-1']);
    expect(w.api.calls).toEqual([]);
    expect(await rowStates(w)).toEqual([['defect-1', 'pending', 0]]);
    expect(w.world.files.paths()).toEqual(['media/defect-1.jpg']);
  });
});
