import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { recordServerStateVector } from '../collab/sync-proof';
import type { Db } from '../platform/db';
import { createListWorld, seedMedia, seedPkg, seedQueued } from '../ui/test-support/worklist-world';
import { countAtRisk } from './at-risk';

/** One stored edit of an inspection's results document; the update bytes are returned. */
async function edit(db: Db, id: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  doc.getMap('results').set('k', 'v');
  await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [`results-${id}`, Y.encodeStateAsUpdate(doc)]);
  return doc;
}

describe('countAtRisk', () => {
  it('is zero on an empty device', async () => {
    const { db } = await createListWorld();
    expect(await countAtRisk(db)).toEqual({ waiting: 0, orphaned: 0, createdHere: 0, unsyncedEdits: 0, total: 0 });
  });

  it('counts waiting uploads, orphaned writes, unconfirmed inspections and unsynced edits, and sums them', async () => {
    const { db } = await createListWorld();
    await seedPkg(db, { id: 'a' });
    await seedPkg(db, { id: 'local', confirmed: 0 });
    await seedMedia(db, 'p1', 'a', 'pending');
    await seedMedia(db, 'p2', 'a', 'failed');
    await seedMedia(db, 'done', 'a', 'uploaded');
    await seedQueued(db, { key: 'k1', seq: 1, inspectionId: 'a' });
    await seedQueued(db, { key: 'k2', seq: 2, inspectionId: 'a', state: 'orphaned' });
    await edit(db, 'a');
    expect(await countAtRisk(db)).toEqual({ waiting: 3, orphaned: 1, createdHere: 1, unsyncedEdits: 1, total: 6 });
  });

  // Signing out or clearing the device warns from this count. A tag change the server has not been told about is not in
  // the queue, so it has to be counted here or it is destroyed without a word.
  it('counts tag changes the server has not been told about, and not tags it already has', async () => {
    const { db } = await createListWorld();
    await seedPkg(db, { id: 'a' });
    const row = (tag: string, state: string): Promise<unknown> =>
      db.run("INSERT INTO item_tags (account_key, inspection_id, item_id, tag_id, name, color, state, updated_at) VALUES ('t%3Au', 'a', 'item-1', ?, 'Urgent', NULL, ?, 1)", [tag, state]);
    await row('t-add', 'add');
    await row('t-remove', 'remove');
    await row('t-synced', 'synced');
    expect(await countAtRisk(db)).toEqual({ waiting: 2, orphaned: 0, createdHere: 0, unsyncedEdits: 0, total: 2 });
  });

  it('control: an uploaded photo and a package the server confirmed are not at risk by themselves', async () => {
    const { db } = await createListWorld();
    await seedPkg(db, { id: 'a', confirmed: 1 });
    await seedMedia(db, 'done', 'a', 'uploaded');
    expect((await countAtRisk(db)).total).toBe(0);
  });
});

describe('countAtRisk: edits in the stored documents', () => {
  it('a document the server has not proven to hold is at risk', async () => {
    const { db } = await createListWorld();
    await edit(db, 'a');
    expect((await countAtRisk(db)).unsyncedEdits).toBe(1);
  });

  it('a document covered by what the server said it holds is not at risk (control)', async () => {
    const { db } = await createListWorld();
    const doc = await edit(db, 'a');
    await recordServerStateVector(db, 'results-a', Y.encodeStateVector(doc), 1);
    expect(await countAtRisk(db)).toMatchObject({ unsyncedEdits: 0, total: 0 });
  });

  it('counts inspections, not rows: several updates of one document are one, two documents are two', async () => {
    const { db } = await createListWorld();
    await edit(db, 'a');
    await edit(db, 'a');
    await edit(db, 'b');
    expect((await countAtRisk(db)).unsyncedEdits).toBe(2);
  });

  it('an uploaded photo whose document is not yet on the server is at risk, through the document', async () => {
    const { db } = await createListWorld();
    await seedPkg(db, { id: 'a' });
    await seedMedia(db, 'done', 'a', 'uploaded');
    await edit(db, 'a');
    const risk = await countAtRisk(db);
    expect(risk.waiting).toBe(0);
    expect(risk.unsyncedEdits).toBe(1);
    expect(risk.total).toBe(1);
  });

  it('a marker that cannot be read counts as not covered', async () => {
    const { db } = await createListWorld();
    const doc = await edit(db, 'a');
    await recordServerStateVector(db, 'results-a', Y.encodeStateVector(doc), 1);
    await db.run("UPDATE ydoc_sync SET covered_state = x'ff' WHERE doc_name = 'results-a'");
    expect((await countAtRisk(db)).unsyncedEdits).toBe(1);
  });

  it('a document that is empty has nothing to lose', async () => {
    const { db } = await createListWorld();
    await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-a', Y.encodeStateAsUpdate(new Y.Doc())]);
    expect((await countAtRisk(db)).unsyncedEdits).toBe(0);
  });

  it('a document that cannot be checked at all (the check itself fails) counts as not covered', async () => {
    const { db } = await createListWorld();
    await edit(db, 'a');
    const failing: Db = { ...db, query: (sql, params) => (/ydoc_sync/.test(sql) ? Promise.reject(new Error('unreadable')) : db.query(sql, params)) } as Db;
    expect((await countAtRisk(failing)).unsyncedEdits).toBe(1);
  });
});
