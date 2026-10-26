import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CollabConnector, PendingMediaRecord, ResultsDocHandle } from '@inspectorhub/field-ui';
import { SqlitePersistence } from '../collab/y-sqlite';
import { createMemoryFiles, type MemoryFiles } from '../app/test-support/memory-files';
import { createMediaStore, type MediaStore } from '../media/store';
import { INSPECTION, jpegBlob, photoRecord } from '../media/test-support/fakes';
import { resolvePendingInDoc } from '../media/pending-doc';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { neverBlocked } from '../test-support/never-blocked';
import { watchRemovedPhotos, withMediaCleanup } from './media-cleanup';
import { photosOf, removePhotos, seedPhotos } from './test-support/doc-seed';
import { reply, scriptedApi } from './test-support/scripted-api';
import { createStoredBlobReader, createUploaderFactory } from './uploader';
import { createForegroundUploads } from './uploader-foreground';

const FINDING = '_default:s1:i1';
const pendingEntry = (pendingId: string, extra: Record<string, unknown> = {}) => ({ key: '', pendingUpload: true, pendingId, pendingKind: 'photo', mediaType: 'photo', ...extra });

let db: Db;
let files: MemoryFiles;
let store: MediaStore;
let log: string[];
let errors: unknown[];

/** Writes `db`'s statements to `log`, in the order they are called. */
function logged(inner: Db): Db {
  return {
    execute: (sql) => inner.execute(sql),
    query: (sql, params) => inner.query(sql, params),
    run: (sql, params) => {
      log.push(sql);
      return inner.run(sql, params);
    },
    transaction: (fn) => inner.transaction(fn),
  };
}

beforeEach(async () => {
  const raw = await createSqlJsDb();
  await migrate(raw, 0);
  log = [];
  errors = [];
  db = logged(raw);
  files = createMemoryFiles();
  store = createMediaStore({ isBlocked: neverBlocked, db, files });
});

const rowIds = async (): Promise<string[]> => (await store.listRows()).map((row) => row.pendingId);
const watch = (doc: Y.Doc) => watchRemovedPhotos(doc, { inspectionId: INSPECTION, store, onError: (error) => errors.push(error) });

describe('a photo removed from the document', () => {
  it('deletes the row and the file of a pending photo that was in the document and is now gone', async () => {
    await store.put(photoRecord('p1'));
    await store.put(photoRecord('p2'));
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('p1'), pendingEntry('p2')]);
    const watcher = watch(doc);
    removePhotos(doc, FINDING, (entry) => entry.pendingId === 'p1');
    await watcher.settled();
    expect(await rowIds()).toEqual(['p2']);
    expect(files.paths()).toEqual(['media/p2.jpg']);
    expect(errors).toEqual([]);
  });

  it('deletes a failed row too', async () => {
    await store.put(photoRecord('p1'));
    await store.markState('p1', 'failed', { attempts: 3 });
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('p1')]);
    const watcher = watch(doc);
    removePhotos(doc, FINDING, () => true);
    await watcher.settled();
    expect(await rowIds()).toEqual([]);
  });

  it('sees a photo that appears after the watch began, and deletes it when it goes', async () => {
    await store.put(photoRecord('p1'));
    const doc = new Y.Doc();
    const watcher = watch(doc);
    seedPhotos(doc, FINDING, [pendingEntry('p1')]);
    removePhotos(doc, FINDING, () => true);
    await watcher.settled();
    expect(await rowIds()).toEqual([]);
  });

  it('leaves a row that is uploading or uploaded alone', async () => {
    await store.put(photoRecord('up'));
    await store.put(photoRecord('done'));
    await store.markState('up', 'uploading', { attempts: 0 });
    await store.markState('done', 'uploaded', { attempts: 0, uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/done.jpg` });
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('up'), pendingEntry('done')]);
    const watcher = watch(doc);
    removePhotos(doc, FINDING, () => true);
    await watcher.settled();
    expect((await store.listRows()).map((row) => [row.pendingId, row.state])).toEqual([
      ['done', 'uploaded'],
      ['up', 'uploading'],
    ]);
  });
});

describe('a row the document never held', () => {
  it('is not deleted: the editor writes the row BEFORE it appends the document entry', async () => {
    await store.put(photoRecord('fresh'));
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [{ key: 'other' }]);
    const watcher = watch(doc);
    // Unrelated edits: a photo is added and another removed while the row waits for its entry.
    seedPhotos(doc, 's2', [{ key: 'x' }]);
    removePhotos(doc, FINDING, (entry) => entry.key === 'other');
    await watcher.settled();
    expect(await rowIds()).toEqual(['fresh']);
    // Control: once its entry has been in the document, removing it does delete the row.
    seedPhotos(doc, 's3', [pendingEntry('fresh')]);
    removePhotos(doc, 's3', () => true);
    await watcher.settled();
    expect(await rowIds()).toEqual([]);
  });

  it('a removal whose row is already gone is quiet', async () => {
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('ghost')]);
    const watcher = watch(doc);
    removePhotos(doc, FINDING, () => true);
    await watcher.settled();
    expect(errors).toEqual([]);
  });
});

describe('the key swap', () => {
  it('a photo whose entry gets its real key keeps its uploaded row for the editor to delete', async () => {
    await store.put(photoRecord('p1'));
    await store.markState('p1', 'uploaded', { attempts: 0, uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/p1.jpg` });
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [pendingEntry('p1')]);
    const watcher = watch(doc);
    expect(resolvePendingInDoc(doc, 'p1', `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`)).toBe('resolved');
    await watcher.settled();
    expect(await rowIds()).toEqual(['p1']);
  });

  it('an entry that loses its pending id in place (a crop or annotation is resolved by editing its entry) releases a row that never started', async () => {
    const crop: PendingMediaRecord = {
      kind: 'crop', pendingId: 'c1', inspectionId: INSPECTION, blob: jpegBlob(2), createdAt: 9,
      meta: { findingKey: FINDING, itemId: 'i1', photoIndex: 0, photoKey: 'base', crop: { aspect: 'free', orientation: 'landscape', x: 0, y: 0, width: 4, height: 4 } },
    };
    await store.put(crop);
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [{ key: 'base', pendingId: 'c1', pendingKind: 'crop' }]);
    const watcher = watch(doc);
    const entry = ((doc.getMap<unknown>('results').get(FINDING) as Y.Map<unknown>).get('photos') as Y.Array<Y.Map<unknown>>).get(0);
    // Control: an edit of another field of the entry changes nothing.
    entry.set('annotationsJson', '[]');
    await watcher.settled();
    expect(await rowIds()).toEqual(['c1']);
    entry.delete('pendingId');
    await watcher.settled();
    expect(await rowIds()).toEqual([]);
  });

  it('is queued in the database before the row is deleted, and nothing is uploaded twice when the editor drains the same queue', async () => {
    const crop: PendingMediaRecord = {
      kind: 'crop',
      pendingId: 'c1',
      inspectionId: INSPECTION,
      blob: jpegBlob(2),
      createdAt: 9,
      meta: { findingKey: FINDING, itemId: 'i1', photoIndex: 0, photoKey: 'base', crop: { aspect: 'free', orientation: 'landscape', x: 0, y: 0, width: 4, height: 4 } },
    };
    await store.put(crop);
    const doc = new Y.Doc();
    seedPhotos(doc, FINDING, [{ key: 'base', pendingId: 'c1', pendingKind: 'crop' }]);
    const persistence = new SqlitePersistence(db, `results-${INSPECTION}`, doc, { onError: (error) => errors.push(error) });
    await persistence.whenSynced;
    // Whether the swap's update had already been issued to the database at the moment the row delete was called.
    const deleteSawSwap: boolean[] = [];
    const watcher = watchRemovedPhotos(doc, {
      inspectionId: INSPECTION,
      store: { deleteIfUnsent: (id, inspectionId) => (deleteSawSwap.push(log.some((sql) => sql.startsWith('INSERT INTO ydoc_updates'))), store.deleteIfUnsent(id, inspectionId)) },
      onError: (error) => errors.push(error),
    });

    const api = scriptedApi(reply(200, { data: { croppedKey: 'cropped-key' } }));
    const uploader = createUploaderFactory({
      isBlocked: neverBlocked,
      store,
      withDoc: (_inspectionId, fn) => Promise.resolve(fn(doc)),
      native: { uploadDetailed: () => Promise.reject(new Error('the background uploader must not be asked')) },
      foreground: createForegroundUploads({ api, readStoredBlob: createStoredBlobReader(store, files), isSynced: () => true }),
    })(INSPECTION, doc);

    // The editor's drain, step by step: list, upload, swap the document, delete the record.
    log.length = 0;
    const [listed] = await store.list(INSPECTION);
    const result = await uploader.upload(listed as PendingMediaRecord);
    expect(result).toEqual({ ok: true, key: 'cropped-key' });
    doc.transact(() => {
      const entry = ((doc.getMap<unknown>('results').get(FINDING) as Y.Map<unknown>).get('photos') as Y.Array<Y.Map<unknown>>).get(0);
      entry.delete('pendingId');
      entry.delete('pendingKind');
      entry.set('croppedKey', 'cropped-key');
    });
    await watcher.settled();
    await persistence.flush();
    expect(deleteSawSwap).toEqual([true]);
    await store.delete('c1');

    const swapAt = log.findIndex((sql) => sql.startsWith('INSERT INTO ydoc_updates'));
    const deleteAt = log.findIndex((sql) => sql.startsWith('DELETE FROM media'));
    expect(swapAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(swapAt);
    expect(api.calls).toHaveLength(1);
    expect(await rowIds()).toEqual([]);
    expect(photosOf(doc, FINDING)).toEqual([{ key: 'base', croppedKey: 'cropped-key' }]);
    expect(errors).toEqual([]);
    await persistence.destroy();
  });
});

describe('the collab wrapper', () => {
  function inner() {
    const docs: Y.Doc[] = [];
    let current = new Y.Doc();
    const destroyed: number[] = [];
    const handle: ResultsDocHandle & { replace(next: Y.Doc): void } = {
      get doc() {
        return current;
      },
      persistenceSynced: Promise.resolve(),
      synced: () => true,
      destroy: () => {
        destroyed.push(1);
      },
      replace: (next) => {
        docs.push(current);
        current = next;
      },
    };
    const connector: CollabConnector = { connect: () => handle, purge: () => Promise.resolve() };
    return { connector, handle, destroyed };
  }

  it('watches the document of every connection and stops when the handle is destroyed', async () => {
    await store.put(photoRecord('p1'));
    await store.put(photoRecord('p2'));
    const { connector, handle } = inner();
    const wrapped = withMediaCleanup(connector, { store, onError: (error) => errors.push(error) });
    const opened = wrapped.connect(INSPECTION, {});
    seedPhotos(handle.doc, FINDING, [pendingEntry('p1'), pendingEntry('p2')]);
    removePhotos(handle.doc, FINDING, (entry) => entry.pendingId === 'p1');
    await opened.persistenceSynced;
    await settle();
    expect(await rowIds()).toEqual(['p2']);

    opened.destroy();
    removePhotos(handle.doc, FINDING, () => true);
    await settle();
    // Control: after destroy nothing is watched any more, so the second row stays.
    expect(await rowIds()).toEqual(['p2']);
  });

  it('a replaced document deletes nothing by itself, even when it is still empty (the restored state has not arrived)', async () => {
    await store.put(photoRecord('p1'));
    const { connector, handle } = inner();
    const wrapped = withMediaCleanup(connector, { store, onError: (error) => errors.push(error) });
    const opened = wrapped.connect(INSPECTION, {});
    seedPhotos(handle.doc, FINDING, [pendingEntry('p1')]);
    handle.replace(new Y.Doc());
    expect(opened.doc).toBe(handle.doc);
    await settle();
    expect(await rowIds()).toEqual(['p1']);
    expect(files.paths()).toEqual(['media/p1.jpg']);
    // The restored state arrives into the new document: the entry is back, and the row was never touched.
    seedPhotos(handle.doc, FINDING, [pendingEntry('p1')]);
    await settle();
    expect(await rowIds()).toEqual(['p1']);
  });

  it('after a replacement, an entry really removed from the NEW document is cleaned; one removed from the old one is not', async () => {
    await store.put(photoRecord('p1'));
    await store.put(photoRecord('p2'));
    const { connector, handle } = inner();
    const wrapped = withMediaCleanup(connector, { store, onError: (error) => errors.push(error) });
    const opened = wrapped.connect(INSPECTION, {});
    const old = handle.doc;
    seedPhotos(old, FINDING, [pendingEntry('p1'), pendingEntry('p2')]);
    const restored = new Y.Doc();
    handle.replace(restored);
    expect(opened.doc).toBe(restored);
    seedPhotos(restored, FINDING, [pendingEntry('p1'), pendingEntry('p2')]);
    removePhotos(old, FINDING, () => true);
    await settle();
    expect(await rowIds()).toEqual(['p1', 'p2']);
    removePhotos(restored, FINDING, (entry) => entry.pendingId === 'p1');
    await settle();
    expect(await rowIds()).toEqual(['p2']);
  });

  it('a document replaced after the handle was destroyed is not followed', async () => {
    await store.put(photoRecord('p1'));
    const { connector, handle } = inner();
    const opened = withMediaCleanup(connector, { store }).connect(INSPECTION, {});
    seedPhotos(handle.doc, FINDING, [pendingEntry('p1')]);
    opened.destroy();
    const next = new Y.Doc();
    handle.replace(next);
    expect(opened.doc).toBe(next);
    seedPhotos(next, FINDING, [pendingEntry('p1')]);
    removePhotos(next, FINDING, () => true);
    await settle();
    expect(await rowIds()).toEqual(['p1']);
  });

  it('passes purge through', async () => {
    const calls: string[] = [];
    const connector: CollabConnector = { connect: inner().connector.connect, purge: (id) => (calls.push(id), Promise.resolve()) };
    await withMediaCleanup(connector, { store }).purge(INSPECTION);
    expect(calls).toEqual([INSPECTION]);
  });
});

/** Lets the deferred removals and their database calls run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
