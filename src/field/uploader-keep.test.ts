import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { MediaError } from '../media/errors';
import { appendPendingInDoc } from '../media/pending-doc-append';
import { MAX_UPLOAD_ATTEMPTS } from '../media/native-uploader';
import { INSPECTION, jpegBlob, photoRecord } from '../media/test-support/fakes';
import { MESSAGES } from './messages';
import { photosOf } from './test-support/doc-seed';
import { reply, scriptedApi } from './test-support/scripted-api';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory, type UploaderDeps } from './uploader';

const FK = '_default:s1:i1';
const keyFor = (pendingId: string): string => `tenant-1/inspections/${INSPECTION}/photos/${pendingId}.jpg`;
const PENDING = (pendingId: string) => ({ key: '', pendingUpload: true, pendingId, pendingKind: 'photo', mediaType: 'photo' });
const photo = (pendingId: string, over: Partial<Extract<PendingMediaRecord, { kind: 'photo' }>> = {}): PendingMediaRecord => ({ ...photoRecord(pendingId), ...over });

const rowStates = async (w: UploaderWorld): Promise<[string, string, number][]> =>
  (await w.world.store.listRows()).map((row) => [row.pendingId, row.state, row.attempts]);

/** Runs `work` to its end while firing the retry timers the uploader sets, one at a time. */
async function driven<T>(w: UploaderWorld, work: Promise<T>, onFire: () => void = () => undefined): Promise<T> {
  let done = false;
  const guarded = work.finally(() => {
    done = true;
  });
  for (let i = 0; i < 200 && !done; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!done && w.docTimers.pending() > 0) {
      onFire();
      w.docTimers.fireNext();
    }
  }
  return guarded;
}

type Code = 'AUTH' | 'LOCKED' | 'UPGRADE' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK' | 'REJECTED' | 'SERVER' | 'PLUGIN' | 'STORE' | 'GIVEN_UP' | 'DISPOSED' | 'FILE' | 'NOT_FOUND' | 'INVALID' | 'UNSUPPORTED_KIND' | 'BLOCKED';
const failedWith = (code: Code, retryable = true) => ({ ok: false as const, code, retryable, retryAfterMs: null, halt: false });
const stubbed = (w: UploaderWorld, code: Code, retryable = true) =>
  createUploaderFactory({ ...w.deps, native: { uploadDetailed: () => Promise.resolve(failedWith(code, retryable)) } });

describe('a failed online upload of an item photo keeps the original', () => {
  it('a transient failure keeps the row (failed, one attempt), appends one pending entry and answers kept', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(await rowStates(w)).toEqual([['p1', 'failed', 1]]);
    expect(w.world.files.paths()).toEqual(['media/p1.jpg']);
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
    expect(w.docCalls).toEqual([INSPECTION]);
    expect(w.errors).toEqual([]);
  });

  it('a permanent refusal keeps the row as given up (attempts at the maximum) and appends the entry', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'complete', statusCode: 422 };
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoUploadFailed, kept: true });
    expect(await rowStates(w)).toEqual([['p1', 'failed', MAX_UPLOAD_ATTEMPTS]]);
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
  });

  it.each<[Code, string]>([
    ['LOCKED', MESSAGES.deviceLocked],
    ['AUTH', MESSAGES.sessionExpired],
    ['UPGRADE', MESSAGES.upgradeRequired],
    ['TOO_LARGE', MESSAGES.photoTooLarge],
    ['TIMEOUT', MESSAGES.unreachable],
    ['NETWORK', MESSAGES.unreachable],
    ['REJECTED', MESSAGES.photoUploadFailed],
    ['SERVER', MESSAGES.photoUploadFailed],
    ['PLUGIN', MESSAGES.photoUploadFailed],
    ['STORE', MESSAGES.photoUploadFailed],
    ['GIVEN_UP', MESSAGES.photoUploadFailed],
    ['DISPOSED', MESSAGES.photoUploadFailed],
    ['FILE', MESSAGES.photoUploadFailed],
  ])('%s: the row stays (pending, nothing was recorded by the stub) and the entry is appended', async (code, sentence) => {
    const w = await createUploaderWorld();
    const result = await stubbed(w, code)(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: sentence, kept: true });
    expect(await rowStates(w)).toEqual([['p1', 'pending', 0]]);
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
  });

  it.each<[Code, boolean]>([
    ['NOT_FOUND', false],
    ['INVALID', false],
    ['UNSUPPORTED_KIND', false],
    ['FILE', false],
  ])('%s (retryable %s) leaves no bytes to keep: no entry, no kept, and the row this call created is removed', async (code, retryable) => {
    const w = await createUploaderWorld();
    const result = await stubbed(w, code, retryable)(INSPECTION, null).upload(photo('p1'));
    expect(result.ok).toBe(false);
    expect('kept' in result).toBe(false);
    expect(w.docCalls).toEqual([]);
    expect(photosOf(w.doc, FK)).toEqual([]);
    expect(await rowStates(w)).toEqual([]);
  });

  it('a block that begins during the upload keeps the row and writes nothing to the document', async () => {
    const w = await createUploaderWorld();
    const result = await stubbed(w, 'BLOCKED', false)(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.blocked });
    expect(await rowStates(w)).toEqual([['p1', 'pending', 0]]);
    expect(w.docCalls).toEqual([]);
    expect(photosOf(w.doc, FK)).toEqual([]);
  });

  it('control: a success removes the row, appends nothing and does not say kept', async () => {
    const w = await createUploaderWorld();
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: true, key: keyFor('p1') });
    expect(await rowStates(w)).toEqual([]);
    expect(w.docCalls).toEqual([]);
    expect(photosOf(w.doc, FK)).toEqual([]);
  });

  it('the row exists before the document is asked for the entry', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const seen: (string | null)[] = [];
    const withDoc: UploaderDeps['withDoc'] = async (inspectionId, fn) => {
      seen.push((await w.world.store.getRow('p1'))?.state ?? null);
      return w.deps.withDoc(inspectionId, fn);
    };
    const result = await createUploaderFactory({ ...w.deps, withDoc })(INSPECTION, null).upload(photo('p1'));
    expect(result.ok).toBe(false);
    expect(seen).toEqual(['failed']);
  });

  it('uses the item id of the record: a key whose last part is another item is refused and nothing is written', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const wrong = photo('p1', { meta: { targetType: 'item', findingKey: '_default:s1:other', itemId: 'i1' } });
    const result = await w.factory(INSPECTION, null).upload(wrong);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoKeptNotAdded });
    expect(w.doc.getMap('results').size).toBe(0);
    expect(await rowStates(w)).toEqual([['p1', 'failed', 1]]);
    expect(w.errors).toHaveLength(1);
    expect(w.errors[0]).toBeInstanceOf(MediaError);
    // Control: the same record with the right key is appended.
    const right = await w.factory(INSPECTION, null).upload(photo('p2'));
    expect(right).toMatchObject({ ok: false, kept: true });
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p2')]);
  });
});

describe('idempotency by pending id', () => {
  it('the same record twice at once leaves one row and one entry', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const uploader = w.factory(INSPECTION, null);
    const [a, b] = await Promise.all([uploader.upload(photo('p1')), uploader.upload(photo('p1'))]);
    expect(a).toMatchObject({ ok: false, kept: true });
    expect(b).toMatchObject({ ok: false, kept: true });
    expect((await w.world.store.listRows()).map((row) => row.pendingId)).toEqual(['p1']);
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
  });

  it('a second call after the first failed does not add a second entry (control: another pending id does)', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const uploader = w.factory(INSPECTION, null);
    await uploader.upload(photo('p1'));
    await uploader.upload(photo('p1'));
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
    await uploader.upload(photo('p2'));
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1'), PENDING('p2')]);
  });

  describe('a row that was already queued (the editor offline path or its drain)', () => {
    const queued = async (w: UploaderWorld): Promise<PendingMediaRecord> => {
      await w.world.store.put(photoRecord('queued'));
      w.plugin.defaultBehavior = { kind: 'fail' };
      const [listed] = await w.world.store.list(INSPECTION);
      return listed as PendingMediaRecord;
    };

    it('answers kept when the document holds its entry, and changes nothing (the document is only read)', async () => {
      const w = await createUploaderWorld();
      appendPendingInDoc(w.doc, FK, 'i1', 'queued');
      const before = Y.encodeStateAsUpdate(w.doc);
      const result = await w.factory(INSPECTION, null).upload(await queued(w));
      expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
      expect(w.docCalls).toEqual([INSPECTION]);
      expect(Y.encodeStateAsUpdate(w.doc)).toEqual(before);
      expect((await w.world.store.listRows()).map((row) => row.pendingId)).toEqual(['queued']);
    });

    it('answers a plain failure when the document has no entry for it, and does not write one', async () => {
      const w = await createUploaderWorld();
      appendPendingInDoc(w.doc, FK, 'i1', 'someone-else');
      const result = await w.factory(INSPECTION, null).upload(await queued(w));
      expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable });
      expect(photosOf(w.doc, FK)).toEqual([PENDING('someone-else')]);
      expect((await w.world.store.listRows()).map((row) => row.pendingId)).toEqual(['queued']);
    });

    it('answers a plain failure when the document cannot be read (and reports it, except for a block)', async () => {
      const w = await createUploaderWorld();
      appendPendingInDoc(w.doc, FK, 'i1', 'queued');
      const rec = await queued(w);
      w.docFailure.error = new MediaError('DOC_FAILED');
      expect(await w.factory(INSPECTION, null).upload(rec)).toStrictEqual({ ok: false, error: MESSAGES.unreachable });
      expect(w.errors).toHaveLength(1);
      w.docFailure.error = new MediaError('BLOCKED');
      expect(await w.factory(INSPECTION, null).upload(rec)).toStrictEqual({ ok: false, error: MESSAGES.unreachable });
      expect(w.errors).toHaveLength(1);
      // Control: with the document readable again the same row is kept.
      w.docFailure.error = null;
      expect(await w.factory(INSPECTION, null).upload(rec)).toMatchObject({ kept: true });
    });

    it('control: a row this call creates gets its entry appended', async () => {
      const w = await createUploaderWorld();
      w.plugin.defaultBehavior = { kind: 'fail' };
      await w.factory(INSPECTION, null).upload(photo('fresh'));
      expect(photosOf(w.doc, FK)).toEqual([PENDING('fresh')]);
    });
  });
});

describe('a background uploader that throws is a retryable failure, not an orphan row', () => {
  const throwing = (w: UploaderWorld) =>
    createUploaderFactory({ ...w.deps, native: { uploadDetailed: () => Promise.reject(new Error('plugin exploded at /secret/path')) } });

  it('keeps the row, appends the entry, answers kept with the generic sentence and leaks nothing of the error', async () => {
    const w = await createUploaderWorld();
    const result = await throwing(w)(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoUploadFailed, kept: true });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(await rowStates(w)).toEqual([['p1', 'pending', 0]]);
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
    expect(w.errors).toEqual([]);
  });

  it('when the entry cannot be written either, the bytes stay and the answer does not claim kept', async () => {
    const w = await createUploaderWorld();
    w.docFailure.error = new MediaError('DOC_FAILED');
    const result = await throwing(w)(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoKeptNotAdded });
    expect(await rowStates(w)).toEqual([['p1', 'pending', 0]]);
  });

  it('control: a failure that does not throw ends in the same state', async () => {
    const w = await createUploaderWorld();
    const result = await stubbed(w, 'PLUGIN')(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoUploadFailed, kept: true });
    expect(await rowStates(w)).toEqual([['p1', 'pending', 0]]);
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
  });
});

describe('when the entry cannot be written the bytes stay and the answer does not claim it', () => {
  it('DOC_BUSY on every try: three tries spaced by the timers, the row stays, no kept, one report', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    w.docFailure.error = new MediaError('DOC_BUSY');
    const result = await driven(w, w.factory(INSPECTION, null).upload(photo('p1')));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoKeptNotAdded });
    expect(w.docCalls).toEqual([INSPECTION, INSPECTION, INSPECTION]);
    expect(w.docTimers.requested()).toEqual([500, 500]);
    expect(await rowStates(w)).toEqual([['p1', 'failed', 1]]);
    expect(w.errors).toHaveLength(1);
    expect(photosOf(w.doc, FK)).toEqual([]);
  });

  it('DOC_BUSY that clears on the second try ends kept with one entry', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    w.docFailure.error = new MediaError('DOC_BUSY');
    const result = await driven(w, w.factory(INSPECTION, null).upload(photo('p1')), () => {
      w.docFailure.error = null;
    });
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
    expect(w.errors).toEqual([]);
  });

  it('DOC_FAILED is not retried: the row stays, no kept, one report', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    w.docFailure.error = new MediaError('DOC_FAILED');
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoKeptNotAdded });
    expect(w.docCalls).toEqual([INSPECTION]);
    expect(w.docTimers.requested()).toEqual([]);
    expect(await rowStates(w)).toEqual([['p1', 'failed', 1]]);
    expect(w.errors).toHaveLength(1);
  });

  it('a block raised by the document step answers the block sentence, keeps the row and reports nothing', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    w.docFailure.error = new MediaError('BLOCKED');
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.blocked });
    expect(await rowStates(w)).toEqual([['p1', 'failed', 1]]);
    expect(w.errors).toEqual([]);
  });

  it('a document step that throws something else is contained: a sentence, never a throw', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    w.docFailure.error = new Error('boom at /secret/path');
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoKeptNotAdded });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('the device store cannot keep the photo', () => {
  it('a disk write failure sends the photo once, straight to the engine (item id only), and answers the key', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { key: 'direct-key' } })) });
    w.world.files.failWrites();
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: true, key: 'direct-key' });
    expect(w.api.calls).toHaveLength(1);
    expect(w.api.calls[0]?.path).toBe(`/api/inspections/${INSPECTION}/upload`);
    expect(w.api.calls[0]?.form?.get('itemId')).toBe('i1');
    expect(w.api.calls[0]?.form?.has('targetType')).toBe(false);
    expect(w.nativeCalls).toEqual([]);
    expect(w.docCalls).toEqual([]);
  });

  it('when the direct upload fails too, the person gets the store sentence, once, with nothing kept', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(500, {})) });
    w.world.files.failWrites();
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(w.api.calls).toHaveLength(1);
    expect(await rowStates(w)).toEqual([]);
  });

  it.each<[string, MediaError, string]>([
    ['TOO_LARGE', new MediaError('TOO_LARGE'), MESSAGES.photoTooLarge],
    ['UNSUPPORTED_TYPE', new MediaError('UNSUPPORTED_TYPE'), MESSAGES.photoTypeUnsupported],
    ['EMPTY', new MediaError('EMPTY'), MESSAGES.photoNotPrepared],
    ['BLOCKED', new MediaError('BLOCKED'), MESSAGES.blocked],
  ])('a policy refusal (%s) is never kept and never sent directly', async (_name, error, sentence) => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { key: 'direct-key' } })) });
    const store: UploaderDeps['store'] = { ...w.world.store, getRow: (id) => w.world.store.getRow(id), put: () => Promise.reject(error), delete: (id) => w.world.store.delete(id) };
    const result = await createUploaderFactory({ ...w.deps, store })(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: sentence });
    expect(w.api.calls).toEqual([]);
    expect(w.docCalls).toEqual([]);
    expect(w.nativeCalls).toEqual([]);
  });

  it('control: the same store failure kinds that are about the disk do reach the direct upload', async () => {
    for (const code of ['WRITE_FAILED', 'DB_FAILED', 'DISK_FULL'] as const) {
      const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { key: 'direct-key' } })) });
      const store: UploaderDeps['store'] = { ...w.world.store, getRow: (id) => w.world.store.getRow(id), put: () => Promise.reject(new MediaError(code)), delete: (id) => w.world.store.delete(id) };
      expect(await createUploaderFactory({ ...w.deps, store })(INSPECTION, null).upload(photo('p1')), code).toStrictEqual({ ok: true, key: 'direct-key' });
      expect(w.api.calls).toHaveLength(1);
    }
  });

  it('an empty photo is refused by the store before anything is kept (control: the same bytes with content are kept)', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const empty = await w.factory(INSPECTION, null).upload(photo('p1', { blob: new Blob([], { type: 'image/jpeg' }) }));
    expect(empty).toStrictEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(w.docCalls).toEqual([]);
    expect(await rowStates(w)).toEqual([]);
    expect(await w.factory(INSPECTION, null).upload(photo('p2', { blob: jpegBlob(2) }))).toMatchObject({ kept: true });
  });
});

describe('a shut sync gate (the real background uploader, not a stub)', () => {
  it('stores the bytes, keeps the row and the entry, and makes no network request at all (control: with the gate open the same photo goes out)', async () => {
    const w = await createUploaderWorld();
    w.locked.value = true;
    const result = await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.deviceLocked, kept: true });
    expect(w.world.files.paths()).toEqual(['media/p1.jpg']);
    expect(await rowStates(w)).toEqual([['p1', 'pending', 0]]);
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
    expect(w.world.engine.http.calls).toEqual([]);
    expect(w.plugin.starts).toHaveLength(0);
    expect(w.api.calls).toEqual([]);

    w.locked.value = false;
    expect(await w.native.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION })).toMatchObject({ ok: true });
    expect(w.world.engine.http.calls.length).toBeGreaterThan(0);
    expect(w.plugin.starts).toHaveLength(1);
  });
});
