import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { createMediaStore, type MediaStore } from '../media/store';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { neverBlocked } from '../test-support/never-blocked';
import { watchRemovedPhotos } from './media-cleanup';
import { removePhotos, seedPhotos } from './test-support/doc-seed';

const FINDING = '_default:s1:i1';
const pendingEntry = (pendingId: string) => ({ key: '', pendingUpload: true, pendingId, pendingKind: 'photo', mediaType: 'photo' });

let store: MediaStore;
let errors: unknown[];

beforeEach(async () => {
  const db = await createSqlJsDb();
  await migrate(db, 0);
  errors = [];
  store = createMediaStore({ isBlocked: neverBlocked, db, files: createMemoryFiles() });
});

const rowIds = async (): Promise<string[]> => (await store.listRows()).map((row) => row.pendingId);
const watch = (doc: Y.Doc) => watchRemovedPhotos(doc, { inspectionId: INSPECTION, store, onError: (error) => errors.push(error) });

describe('the guarded delete and the watcher lifecycle', () => {
  it('never deletes the row of another inspection, even for an id that was in this document (control: its own row goes)', async () => {
    await store.put({ ...photoRecord('mine'), inspectionId: INSPECTION });
    await store.put({ ...photoRecord('theirs'), inspectionId: 'insp-other' });
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('mine'), pendingEntry('theirs')]);
    const watcher = watch(doc);
    removePhotos(doc, FINDING, () => true);
    await watcher.settled();
    expect((await store.listRows()).map((row) => row.pendingId)).toEqual(['theirs']);
  });

  it('a row that began uploading after the entry went is kept (the delete re-checks at delete time)', async () => {
    await store.put(photoRecord('p1'));
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('p1')]);
    const guarded = { deleteIfUnsent: async (id: string, insp: string) => (await store.markState(id, 'uploading', { attempts: 0 }), store.deleteIfUnsent(id, insp)) };
    const watcher = watchRemovedPhotos(doc, { inspectionId: INSPECTION, store: guarded });
    removePhotos(doc, FINDING, () => true);
    await watcher.settled();
    expect((await store.listRows()).map((row) => [row.pendingId, row.state])).toEqual([['p1', 'uploading']]);
  });

  it('asks for a delete once per removed entry, and an id that left the document is not asked about again', async () => {
    await store.put(photoRecord('p1'));
    const asked: string[] = [];
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('p1')]);
    const watcher = watchRemovedPhotos(doc, { inspectionId: INSPECTION, store: { deleteIfUnsent: (id, insp) => (asked.push(id), store.deleteIfUnsent(id, insp)) } });
    removePhotos(doc, FINDING, () => true);
    seedPhotos(doc, 's2', [{ key: 'other' }]);
    seedPhotos(doc, 's3', [{ key: 'another' }]);
    await watcher.settled();
    expect(asked).toEqual(['p1']);
  });

  it('a removal whose row is gone changes nothing and reports nothing; control: with a row it deletes', async () => {
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('ghost')]);
    const watcher = watch(doc);
    removePhotos(doc, FINDING, () => true);
    await watcher.settled();
    expect(errors).toEqual([]);
    expect(await store.deleteIfUnsent('ghost', INSPECTION)).toBe(false);
  });

  it('after stop, a removal in the document is not seen', async () => {
    await store.put(photoRecord('p1'));
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('p1')]);
    const watcher = watch(doc);
    watcher.stop();
    removePhotos(doc, FINDING, () => true);
    await watcher.settled();
    expect(await rowIds()).toEqual(['p1']);
  });

  it('a replaced document is rebuilt as the baseline: ids it holds count as seen, ids it lacks do not', async () => {
    await store.put(photoRecord('old'));
    await store.put(photoRecord('new'));
    const first = new Y.Doc();
    seedPhotos(first, FINDING, [pendingEntry('old')]);
    const watcher = watch(first);
    const second = new Y.Doc();
    seedPhotos(second, FINDING, [pendingEntry('new')]);
    watcher.follow(second);
    removePhotos(second, FINDING, () => true);
    await watcher.settled();
    expect(await rowIds()).toEqual(['old']);
  });
});

