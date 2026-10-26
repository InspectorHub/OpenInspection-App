import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { resultsDocName } from '../collab/connector';
import { SqlitePersistence } from '../collab/y-sqlite';
import { createManualTimers } from '../collab/test-support/manual-timers';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createPendingResolver, createWithDoc, resolvePendingInDoc, type DocPorts } from './pending-doc';
import { neverBlocked } from '../test-support/never-blocked';

const KEY = 'tenant-1/inspections/insp-1/photos/pend-1.jpg';

/** The shape the editor writes for an offline photo: a results map, an item map, a photos array of maps. */
function seed(doc: Y.Doc, findingKey: string, photos: Record<string, unknown>[]): void {
  const results = doc.getMap<unknown>('results');
  doc.transact(() => {
    const item = new Y.Map<unknown>();
    const arr = new Y.Array<unknown>();
    for (const photo of photos) {
      const el = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(photo)) el.set(k, v);
      arr.push([el]);
    }
    item.set('photos', arr);
    results.set(findingKey, item);
  });
}

function photosOf(doc: Y.Doc, findingKey: string): Record<string, unknown>[] {
  const item = doc.getMap<unknown>('results').get(findingKey);
  if (!(item instanceof Y.Map)) return [];
  const arr = item.get('photos');
  return arr instanceof Y.Array ? arr.toArray().map((el) => (el as Y.Map<unknown>).toJSON() as Record<string, unknown>) : [];
}

const pendingEntry = (pendingId: string, extra: Record<string, unknown> = {}) => ({
  key: '', pendingUpload: true, pendingId, pendingKind: 'photo', mediaType: 'photo', ...extra,
});

describe('resolvePendingInDoc (mirror of the package resolver for a new photo)', () => {
  it('replaces the pending entry in place with the official key and drops the pending fields', () => {
    const doc = new Y.Doc();
    seed(doc, '_default:s1:i1', [{ key: 'before.jpg', mediaType: 'photo' }, pendingEntry('pend-1', { annotationsJson: '[]' }), { key: 'after.jpg' }]);
    expect(resolvePendingInDoc(doc, 'pend-1', KEY)).toBe('resolved');
    expect(photosOf(doc, '_default:s1:i1')).toEqual([
      { key: 'before.jpg', mediaType: 'photo' },
      { key: KEY, mediaType: 'photo', annotationsJson: '[]' },
      { key: 'after.jpg' },
    ]);
  });

  it('is idempotent: a second call finds the official key and changes nothing; an unknown id is "missing"', () => {
    const doc = new Y.Doc();
    seed(doc, 'k', [pendingEntry('pend-1')]);
    expect(resolvePendingInDoc(doc, 'pend-1', KEY)).toBe('resolved');
    const after = Y.encodeStateAsUpdate(doc);
    expect(resolvePendingInDoc(doc, 'pend-1', KEY)).toBe('already');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(after);
    expect(resolvePendingInDoc(doc, 'someone-else', 'tenant-1/inspections/insp-1/photos/someone-else.jpg')).toBe('missing');
    expect(photosOf(doc, 'k')).toHaveLength(1);
  });

  it('finds the entry under any finding key and does not touch other pending entries', () => {
    const doc = new Y.Doc();
    seed(doc, 'a', [pendingEntry('other')]);
    seed(doc, 'b', [pendingEntry('pend-1')]);
    expect(resolvePendingInDoc(doc, 'pend-1', KEY)).toBe('resolved');
    expect(photosOf(doc, 'a')[0]).toMatchObject({ pendingId: 'other', pendingUpload: true });
    expect(photosOf(doc, 'b')[0]).toMatchObject({ key: KEY });
  });

  it('ignores an entry that carries the id but is a pending derivative (not a new photo)', () => {
    const doc = new Y.Doc();
    seed(doc, 'k', [{ key: 'base.jpg', pendingId: 'pend-1', pendingKind: 'crop' }]);
    expect(resolvePendingInDoc(doc, 'pend-1', KEY)).toBe('missing');
    expect(photosOf(doc, 'k')[0]).toMatchObject({ key: 'base.jpg', pendingKind: 'crop' });
  });

  it('tolerates items without a photos array and non-map values', () => {
    const doc = new Y.Doc();
    const results = doc.getMap<unknown>('results');
    results.set('odd', 'a string');
    results.set('empty', new Y.Map<unknown>());
    expect(resolvePendingInDoc(doc, 'pend-1', KEY)).toBe('missing');
  });
});

async function persistedDoc(db: Db, inspectionId: string, build: (doc: Y.Doc) => void): Promise<void> {
  const doc = new Y.Doc();
  const persistence = new SqlitePersistence(db, resultsDocName(inspectionId), doc);
  await persistence.whenSynced;
  build(doc);
  await persistence.destroy();
  doc.destroy();
}

async function reload(db: Db, inspectionId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  await new SqlitePersistence(db, resultsDocName(inspectionId), doc).whenSynced;
  return doc;
}

async function rowCount(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates');
  return Number(rows[0]?.n ?? 0);
}

describe('withDoc: the live document and the short-lived one', () => {
  it('uses the live document when the connector reports one open, and writes nothing to the table itself', async () => {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    const live = new Y.Doc();
    seed(live, 'k', [pendingEntry('pend-1')]);
    const opened: string[] = [];
    const docs: DocPorts = { isOpen: (id) => { opened.push(id); return true; }, liveDoc: () => live };
    const resolve = createPendingResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs }) });
    await expect(resolve('insp-1', 'pend-1', KEY)).resolves.toBe('resolved');
    expect(photosOf(live, 'k')[0]).toMatchObject({ key: KEY });
    expect(opened).toEqual(['insp-1']);
    // The live document's own persistence stores that edit; this path opened no second persistence.
    expect(await rowCount(db)).toBe(0);
  });

  it('with no live document, applies the change through a short-lived persisted one that survives a reload', async () => {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    await persistedDoc(db, 'insp-1', (doc) => seed(doc, 'k', [pendingEntry('pend-1'), pendingEntry('pend-2')]));
    const rowsBefore = await rowCount(db);
    expect(rowsBefore).toBeGreaterThan(0);

    const docs: DocPorts = { isOpen: () => false, liveDoc: () => null };
    const resolve = createPendingResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs, timers: createManualTimers() }) });
    await expect(resolve('insp-1', 'pend-1', KEY)).resolves.toBe('resolved');

    const reopened = await reload(db, 'insp-1');
    const photos = photosOf(reopened, 'k');
    expect(photos[0]).toMatchObject({ key: KEY });
    expect(photos[0]).not.toHaveProperty('pendingUpload');
    expect(photos[1]).toMatchObject({ pendingId: 'pend-2', pendingUpload: true });
    expect(await rowCount(db)).toBeGreaterThan(rowsBefore);
    // Control: a second resolve through a fresh short-lived document is the idempotent "already".
    await expect(resolve('insp-1', 'pend-1', KEY)).resolves.toBe('already');
  });

  it('an inspection with no stored document answers "missing" and stores nothing', async () => {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    const docs: DocPorts = { isOpen: () => false, liveDoc: () => null };
    const resolve = createPendingResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs }) });
    await expect(resolve('insp-1', 'pend-1', KEY)).resolves.toBe('missing');
    expect(await rowCount(db)).toBe(0);
  });

  it('never opens a second document while the connector holds one but its doc is not available', async () => {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    await persistedDoc(db, 'insp-1', (doc) => seed(doc, 'k', [pendingEntry('pend-1')]));
    const before = await rowCount(db);
    const docs: DocPorts = { isOpen: () => true, liveDoc: () => null };
    const resolve = createPendingResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs }) });
    await expect(resolve('insp-1', 'pend-1', KEY)).rejects.toMatchObject({ code: 'DOC_BUSY' });
    expect(await rowCount(db)).toBe(before);
    expect(photosOf(await reload(db, 'insp-1'), 'k')[0]).toMatchObject({ pendingId: 'pend-1', pendingUpload: true });
  });

  it('refuses an invalid inspection id before touching the table', async () => {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    const docs: DocPorts = { isOpen: () => false, liveDoc: () => null };
    const resolve = createPendingResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs }) });
    await expect(resolve('../x', 'pend-1', KEY)).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(resolve('insp-1', 'a/b', KEY)).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(resolve('insp-1', 'pend-1', 'not a key')).rejects.toMatchObject({ code: 'INVALID_RECORD' });
  });
});

/** A Db that refuses every INSERT into the update table once `armed` is set, as a full disk does. */
function failingInsertDb(inner: Db): Db & { arm(): void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    execute: (sql) => inner.execute(sql),
    query: (sql, params) => inner.query(sql, params),
    run: (sql, params) => (armed && sql.includes('INSERT INTO ydoc_updates') ? Promise.reject(new Error('disk I/O error')) : inner.run(sql, params)),
    transaction: (fn) => inner.transaction(fn),
  };
}

describe('withDoc: a change that did not reach the table is never reported as resolved (M-2)', () => {
  it('an INSERT that fails makes the resolve fail with DOC_FAILED, reports the error, and leaves the stored document untouched', async () => {
    const inner = await createSqlJsDb();
    await migrate(inner, 0);
    await persistedDoc(inner, 'insp-1', (doc) => seed(doc, 'k', [pendingEntry('pend-1')]));
    const db = failingInsertDb(inner);
    db.arm();
    const errors: unknown[] = [];
    const docs: DocPorts = { isOpen: () => false, liveDoc: () => null };
    const resolve = createPendingResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs, timers: createManualTimers(), onError: (e) => errors.push(e) }) });
    await expect(resolve('insp-1', 'pend-1', KEY)).rejects.toMatchObject({ code: 'DOC_FAILED' });
    expect(errors.length).toBeGreaterThan(0);
    expect(photosOf(await reload(inner, 'insp-1'), 'k')[0]).toMatchObject({ pendingId: 'pend-1', pendingUpload: true, key: '' });
  });

  it('positive control: a healthy Db resolves and a fresh document read from the table carries the key', async () => {
    const inner = await createSqlJsDb();
    await migrate(inner, 0);
    await persistedDoc(inner, 'insp-1', (doc) => seed(doc, 'k', [pendingEntry('pend-1')]));
    const db = failingInsertDb(inner);
    const errors: unknown[] = [];
    const docs: DocPorts = { isOpen: () => false, liveDoc: () => null };
    const resolve = createPendingResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs, timers: createManualTimers(), onError: (e) => errors.push(e) }) });
    await expect(resolve('insp-1', 'pend-1', KEY)).resolves.toBe('resolved');
    expect(errors).toEqual([]);
    expect(photosOf(await reload(inner, 'insp-1'), 'k')[0]).toMatchObject({ key: KEY });
  });

  it('a stored state that does not match the document after the write is also DOC_FAILED', async () => {
    const inner = await createSqlJsDb();
    await migrate(inner, 0);
    await persistedDoc(inner, 'insp-1', (doc) => seed(doc, 'k', [pendingEntry('pend-1')]));
    // Swallows the insert without an error: the write "succeeds" but nothing is stored.
    const db: Db = {
      execute: (sql) => inner.execute(sql),
      query: (sql, params) => inner.query(sql, params),
      run: (sql, params) => (sql.includes('INSERT INTO ydoc_updates') ? Promise.resolve({ changes: 0 }) : inner.run(sql, params)),
      transaction: (fn) => inner.transaction(fn),
    };
    const docs: DocPorts = { isOpen: () => false, liveDoc: () => null };
    const resolve = createPendingResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs, timers: createManualTimers() }) });
    await expect(resolve('insp-1', 'pend-1', KEY)).rejects.toMatchObject({ code: 'DOC_FAILED' });
  });
});
