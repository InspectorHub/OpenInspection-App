import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { watchRemovedPhotos } from './media-cleanup';
import { photosOf, removePhotos } from './test-support/doc-seed';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory } from './uploader';

/**
 * A photo kept after a failed online upload has a device row and a pending entry the uploader appended. These tests
 * pin how that entry meets the removed-photo watcher: the row goes only when the person removes the entry from the
 * document they are editing, and never because a document was closed, replaced or swapped.
 */

const FK = '_default:s1:i1';
const photo = (pendingId: string): PendingMediaRecord => photoRecord(pendingId);
const rowStates = async (w: UploaderWorld): Promise<[string, string][]> => (await w.world.store.listRows()).map((row) => [row.pendingId, row.state]);

async function failedWorld(): Promise<UploaderWorld> {
  const w = await createUploaderWorld();
  w.plugin.defaultBehavior = { kind: 'fail' };
  return w;
}

const watch = (w: UploaderWorld, doc: Y.Doc) => watchRemovedPhotos(doc, { inspectionId: INSPECTION, store: w.world.store, onError: (error) => w.errors.push(error) });

describe('a kept photo and the removed-photo watcher', () => {
  it('the person removes the appended entry from the live document: a failed row and its file are deleted (positive control)', async () => {
    const w = await failedWorld();
    const watcher = watch(w, w.doc);
    expect(await w.factory(INSPECTION, null).upload(photo('p1'))).toMatchObject({ ok: false, kept: true });
    expect(await rowStates(w)).toEqual([['p1', 'failed']]);
    expect(photosOf(w.doc, FK)).toHaveLength(1);
    removePhotos(w.doc, FK, (entry) => entry.pendingId === 'p1');
    await watcher.settled();
    expect(await rowStates(w)).toEqual([]);
    expect(w.world.files.paths()).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it('the same removal deletes a row that is still pending, and only the removed photo\'s row', async () => {
    const w = await createUploaderWorld();
    const watcher = watch(w, w.doc);
    const stub = createUploaderFactory({ ...w.deps, native: { uploadDetailed: () => Promise.resolve({ ok: false, code: 'LOCKED', retryable: true, retryAfterMs: null, halt: true }) } });
    await stub(INSPECTION, null).upload(photo('p1'));
    await stub(INSPECTION, null).upload(photo('p2'));
    expect(await rowStates(w)).toEqual([['p1', 'pending'], ['p2', 'pending']]);
    removePhotos(w.doc, FK, (entry) => entry.pendingId === 'p1');
    await watcher.settled();
    expect(await rowStates(w)).toEqual([['p2', 'pending']]);
    expect(photosOf(w.doc, FK)).toHaveLength(1);
  });

  it('an entry appended to a short-lived document (the editor is closed) deletes nothing; once the editor opens it, a removal does', async () => {
    const w = await failedWorld();
    const editorDoc = new Y.Doc();
    const watcher = watch(w, editorDoc);
    const shortLived = new Y.Doc();
    const elsewhere = createUploaderFactory({ ...w.deps, withDoc: (_inspectionId, fn) => Promise.resolve(fn(shortLived)) });
    expect(await elsewhere(INSPECTION, null).upload(photo('p1'))).toMatchObject({ ok: false, kept: true });
    expect(photosOf(shortLived, FK)).toHaveLength(1);
    removePhotos(shortLived, FK, () => true);
    await watcher.settled();
    // The watched document never saw the entry and nothing was removed from it, so the row is untouched.
    expect(await rowStates(w)).toEqual([['p1', 'failed']]);

    // The editor opens the stored document: the entry is in it, the watcher counts it as seen from the start.
    const stored = new Y.Doc();
    const kept = createUploaderFactory({ ...w.deps, withDoc: (_inspectionId, fn) => Promise.resolve(fn(stored)) });
    await kept(INSPECTION, null).upload(photo('p2'));
    const opened = new Y.Doc();
    Y.applyUpdate(opened, Y.encodeStateAsUpdate(stored));
    const reopened = watch(w, opened);
    removePhotos(opened, FK, (entry) => entry.pendingId === 'p2');
    await reopened.settled();
    expect(await rowStates(w)).toEqual([['p1', 'failed']]);
  });

  it('a version restore that swaps in an empty document deletes nothing; control: a removal on the document that was swapped in does', async () => {
    const w = await failedWorld();
    const watcher = watch(w, w.doc);
    await w.factory(INSPECTION, null).upload(photo('p1'));
    expect(photosOf(w.doc, FK)).toHaveLength(1);
    const restored = new Y.Doc();
    watcher.follow(restored);
    await watcher.settled();
    expect(await rowStates(w)).toEqual([['p1', 'failed']]);
    expect(w.world.files.paths()).toEqual(['media/p1.jpg']);
    // The restored state brings the entry back; it is seen again, and only now does a removal delete.
    const entryOnly = new Y.Doc();
    Y.applyUpdate(entryOnly, Y.encodeStateAsUpdate(w.doc));
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(entryOnly));
    removePhotos(restored, FK, (entry) => entry.pendingId === 'p1');
    await watcher.settled();
    expect(await rowStates(w)).toEqual([]);
  });

  it('a removal while the row is uploading keeps the row (control: the same removal of a failed row deletes it)', async () => {
    const w = await failedWorld();
    const watcher = watch(w, w.doc);
    await w.factory(INSPECTION, null).upload(photo('busy'));
    await w.factory(INSPECTION, null).upload(photo('idle'));
    expect(await w.world.store.markState('busy', 'uploading', { attempts: 1 })).toBe(true);
    removePhotos(w.doc, FK, () => true);
    await watcher.settled();
    expect(await rowStates(w)).toEqual([['busy', 'uploading']]);
  });

  it('a row that is uploaded is kept too: the swap to the real key is the editor\'s to finish', async () => {
    const w = await failedWorld();
    const watcher = watch(w, w.doc);
    await w.factory(INSPECTION, null).upload(photo('done'));
    expect(await w.world.store.markState('done', 'uploaded', { attempts: 1, uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/done.jpg` })).toBe(true);
    removePhotos(w.doc, FK, () => true);
    await watcher.settled();
    expect(await rowStates(w)).toEqual([['done', 'uploaded']]);
  });
});
