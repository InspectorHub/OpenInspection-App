import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { readSyncMarker } from '../offline/sync-marker';
import { MAX_COVERAGE_SCRATCH_BYTES, clearSyncProof, deleteSetKey, docIsCovered, recordServerDeleteSet, recordServerStateVector } from './sync-proof';

const DOC = 'results-insp-1';

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

/** A document whose every update is also stored the way the connector stores it: one `ydoc_updates` row per update. */
function localDoc(): { doc: Y.Doc; rows: Uint8Array[] } {
  const doc = new Y.Doc();
  const rows: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => rows.push(update));
  return { doc, rows };
}

async function store(rows: readonly Uint8Array[], docName = DOC): Promise<void> {
  for (const data of rows) await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [docName, data]);
}

/** What a server that holds exactly the given updates would send as its step 1. */
function serverState(updates: readonly Uint8Array[]): { doc: Y.Doc; sv: Uint8Array } {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return { doc, sv: Y.encodeStateVector(doc) };
}

describe('recording what the server said', () => {
  it('stores the server state vector exactly as it was observed', async () => {
    const server = serverState([]);
    server.doc.getMap<unknown>('m').set('a', 1);
    const sv = Y.encodeStateVector(server.doc);
    await recordServerStateVector(db, DOC, sv, 55);
    const marker = await readSyncMarker(db, DOC);
    expect([...(marker?.coveredState ?? [])]).toEqual([...sv]);
    expect(marker?.updatedAt).toBe(55);
  });

  it('refuses bytes that are not a state vector and leaves an earlier marker alone', async () => {
    const good = Y.encodeStateVector(serverState([]).doc);
    await recordServerStateVector(db, DOC, good, 1);
    await expect(recordServerStateVector(db, DOC, Uint8Array.from([255]), 2)).rejects.toThrow();
    const marker = await readSyncMarker(db, DOC);
    expect(marker?.updatedAt).toBe(1);
  });

  it('refuses a delete set update that cannot be read', async () => {
    await expect(recordServerDeleteSet(db, DOC, Uint8Array.from([255, 255]), 1)).rejects.toThrow();
    expect(await readSyncMarker(db, deleteSetKey(DOC))).toBeNull();
  });

  it('forgets the earlier delete set when a newer state vector is observed: the two always belong to one observation', async () => {
    const a = localDoc();
    a.doc.getMap<unknown>('m').set('k', 1);
    a.doc.getMap<unknown>('m').delete('k');
    await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(a.doc), 1);
    expect(await readSyncMarker(db, deleteSetKey(DOC))).not.toBeNull();
    await recordServerStateVector(db, DOC, Y.encodeStateVector(a.doc), 2);
    expect(await readSyncMarker(db, deleteSetKey(DOC))).toBeNull();
  });

  it('clearSyncProof removes both rows of one document and nothing else', async () => {
    await recordServerStateVector(db, DOC, Y.encodeStateVector(new Y.Doc()), 1);
    await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(new Y.Doc()), 1);
    await recordServerStateVector(db, 'results-other', Y.encodeStateVector(new Y.Doc()), 1);
    await clearSyncProof(db, DOC);
    expect(await readSyncMarker(db, DOC)).toBeNull();
    expect(await readSyncMarker(db, deleteSetKey(DOC))).toBeNull();
    expect(await readSyncMarker(db, 'results-other')).not.toBeNull();
  });
});

describe('docIsCovered', () => {
  it('is true for a document with nothing in it, with no marker at all', async () => {
    expect(await docIsCovered(db, DOC)).toBe(true);
  });

  it('is true for a stored update that carries no structs and no deletions', async () => {
    await store([Y.encodeStateAsUpdate(new Y.Doc())]);
    expect(await docIsCovered(db, DOC)).toBe(true);
  });

  it('is false for local content without a marker, and true for the same content once the server state vector covers it', async () => {
    const { doc, rows } = localDoc();
    doc.getMap<unknown>('m').set('a', 1);
    await store(rows);
    expect(await docIsCovered(db, DOC)).toBe(false);

    await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
    expect(await docIsCovered(db, DOC)).toBe(true);
  });

  it('is false for an edit made after the marker was taken, and true again once a later observation includes it', async () => {
    const { doc, rows } = localDoc();
    doc.getMap<unknown>('m').set('a', 1);
    await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
    doc.getMap<unknown>('n').set('b', 2);
    await store(rows);
    expect(await docIsCovered(db, DOC)).toBe(false);

    await recordServerStateVector(db, DOC, serverState(rows).sv, 2);
    expect(await docIsCovered(db, DOC)).toBe(true);
  });

  it('is still true when the server has more than this device: other people edits never count against it', async () => {
    const { doc, rows } = localDoc();
    doc.getMap<unknown>('m').set('mine', 1);
    await store(rows);
    const server = serverState(rows);
    const other = new Y.Doc();
    other.getMap<unknown>('x').set('theirs', 1);
    Y.applyUpdate(server.doc, Y.encodeStateAsUpdate(other));
    await recordServerStateVector(db, DOC, Y.encodeStateVector(server.doc), 1);
    expect(await docIsCovered(db, DOC)).toBe(true);
  });

  it('is false when a marker covers a different editing client than the stored content', async () => {
    const { doc, rows } = localDoc();
    doc.getMap<unknown>('m').set('mine', 1);
    await store(rows);
    const foreign = new Y.Doc();
    foreign.getMap<unknown>('m').set('theirs', 1);
    await recordServerStateVector(db, DOC, Y.encodeStateVector(foreign), 1);
    expect(await docIsCovered(db, DOC)).toBe(false);
  });

  it('reads the marker of this document only', async () => {
    const { doc, rows } = localDoc();
    doc.getMap<unknown>('m').set('a', 1);
    await store(rows);
    await recordServerStateVector(db, 'results-insp-2', serverState(rows).sv, 1);
    expect(await docIsCovered(db, DOC)).toBe(false);
  });

  it('is false for a marker that is not a state vector, and for a truncated one; the same rows with a good marker are covered', async () => {
    const { doc, rows } = localDoc();
    doc.getMap<unknown>('m').set('a', 1);
    await store(rows);
    const good = serverState(rows).sv;

    await db.run('INSERT INTO ydoc_sync (doc_name, covered_state, updated_at) VALUES (?, ?, 1)', [DOC, Uint8Array.from([255, 255, 255])]);
    expect(await docIsCovered(db, DOC)).toBe(false);
    await db.run('UPDATE ydoc_sync SET covered_state = ? WHERE doc_name = ?', [good.slice(0, good.length - 1), DOC]);
    expect(await docIsCovered(db, DOC)).toBe(false);
    await db.run('UPDATE ydoc_sync SET covered_state = NULL WHERE doc_name = ?', [DOC]);
    expect(await docIsCovered(db, DOC)).toBe(false);

    await db.run('UPDATE ydoc_sync SET covered_state = ? WHERE doc_name = ?', [good, DOC]);
    expect(await docIsCovered(db, DOC)).toBe(true);
  });

  it('is false when a stored row cannot be applied, and when it is not binary', async () => {
    const { doc, rows } = localDoc();
    doc.getMap<unknown>('m').set('a', 1);
    await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
    await store(rows);
    expect(await docIsCovered(db, DOC)).toBe(true);

    await store([Uint8Array.from([255, 255, 255, 255])]);
    expect(await docIsCovered(db, DOC)).toBe(false);
    await db.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [DOC]);
    await store(rows);
    await db.run("INSERT INTO ydoc_updates (doc_name, data) VALUES (?, 'text, not bytes')", [DOC]);
    expect(await docIsCovered(db, DOC)).toBe(false);
  });

  it('is false when a stored update depends on content that is not stored, and true when the whole history is', async () => {
    const { doc, rows } = localDoc();
    doc.getMap<unknown>('m').set('a', 1);
    doc.getMap<unknown>('m').set('a', 2);
    await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
    await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(doc), 1);
    await store(rows.slice(1));
    expect(await docIsCovered(db, DOC)).toBe(false);

    await db.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [DOC]);
    await store(rows);
    expect(await docIsCovered(db, DOC)).toBe(true);
  });

  describe('a history with holes is never covered, however the clocks look', () => {
    it('a missing middle update leaves the later one pending: the state vector looks covered, the document is not', async () => {
      const { doc, rows } = localDoc();
      doc.getMap<unknown>('m').set('a', 1);
      doc.getMap<unknown>('n').set('b', 2);
      doc.getMap<unknown>('o').set('c', 3);
      expect(rows).toHaveLength(3);
      await store([rows[0] as Uint8Array, rows[2] as Uint8Array]);
      await recordServerStateVector(db, DOC, serverState([rows[0] as Uint8Array]).sv, 1);
      expect(await docIsCovered(db, DOC)).toBe(false);
    });

    it('control: the complete history with the same kind of marker is covered', async () => {
      const { doc, rows } = localDoc();
      doc.getMap<unknown>('m').set('a', 1);
      doc.getMap<unknown>('n').set('b', 2);
      doc.getMap<unknown>('o').set('c', 3);
      await store(rows);
      await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
      expect(await docIsCovered(db, DOC)).toBe(true);
    });

    it('a stored deletion of an item whose creation is not stored is pending: an empty local state vector and a server delete set that contains the deletion do not make it covered', async () => {
      const { doc, rows } = localDoc();
      doc.getMap<unknown>('m').set('k', 1);
      doc.getMap<unknown>('m').delete('k');
      expect(rows).toHaveLength(2);
      await store([rows[1] as Uint8Array]);
      const probe = new Y.Doc();
      Y.applyUpdate(probe, rows[1] as Uint8Array);
      expect(probe.store.pendingDs).not.toBeNull();
      expect(Y.decodeStateVector(Y.encodeStateVector(probe)).size).toBe(0);
      await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
      await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(serverState(rows).doc), 2);
      expect(await docIsCovered(db, DOC)).toBe(false);
    });

    it('control: with the creation stored too, the same deletion is covered by the same markers', async () => {
      const { doc, rows } = localDoc();
      doc.getMap<unknown>('m').set('k', 1);
      doc.getMap<unknown>('m').delete('k');
      await store(rows);
      await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
      await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(serverState(rows).doc), 2);
      expect(await docIsCovered(db, DOC)).toBe(true);
    });
  });

  describe('deletions, which a state vector does not describe', () => {
    async function offlineDeletion(): Promise<{ serverSv: Uint8Array; serverUpdate: Uint8Array; rows: Uint8Array[] }> {
      const server = new Y.Doc();
      server.getMap<unknown>('m').set('k', 'value');
      const base = Y.encodeStateAsUpdate(server);
      const local = new Y.Doc();
      Y.applyUpdate(local, base);
      const rows: Uint8Array[] = [base];
      local.on('update', (update: Uint8Array) => rows.push(update));
      local.getMap<unknown>('m').delete('k');
      return { serverSv: Y.encodeStateVector(server), serverUpdate: base, rows };
    }

    it('a deletion made only on this device is not covered by a state vector that already included the content', async () => {
      const { serverSv, rows } = await offlineDeletion();
      await store(rows);
      await recordServerStateVector(db, DOC, serverSv, 1);
      expect(await docIsCovered(db, DOC)).toBe(false);
    });

    it('control: the same device is covered once the server delete set contains that deletion', async () => {
      const { serverSv, rows } = await offlineDeletion();
      await store(rows);
      await recordServerStateVector(db, DOC, serverSv, 1);
      const server = serverState(rows).doc;
      await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(server), 2);
      expect(await docIsCovered(db, DOC)).toBe(true);
    });

    it('a delete set that holds a different deletion does not cover this one', async () => {
      const { serverSv, rows } = await offlineDeletion();
      await store(rows);
      await recordServerStateVector(db, DOC, serverSv, 1);
      const elsewhere = new Y.Doc();
      elsewhere.getMap<unknown>('m').set('other', 1);
      elsewhere.getMap<unknown>('m').delete('other');
      await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(elsewhere), 2);
      expect(await docIsCovered(db, DOC)).toBe(false);
    });

    it('a corrupt delete set row is no delete set', async () => {
      const { serverSv, rows } = await offlineDeletion();
      await store(rows);
      await recordServerStateVector(db, DOC, serverSv, 1);
      await db.run('INSERT INTO ydoc_sync (doc_name, covered_state, updated_at) VALUES (?, ?, 1)', [deleteSetKey(DOC), Uint8Array.from([9, 9, 9, 9, 9])]);
      expect(await docIsCovered(db, DOC)).toBe(false);
    });

    it('a deletion is covered only by a server range that contains all of it, not one that merely touches it', async () => {
      const local = localDoc();
      local.doc.getText('t').insert(0, 'abc');
      const server = serverState(local.rows);
      local.doc.getText('t').delete(0, 3);
      await store(local.rows);
      await recordServerStateVector(db, DOC, server.sv, 1);

      const partial = serverState(local.rows.slice(0, 1));
      partial.doc.getText('t').delete(0, 1);
      await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(partial.doc), 2);
      expect(await docIsCovered(db, DOC)).toBe(false);

      await recordServerStateVector(db, DOC, server.sv, 3);
      await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(serverState(local.rows).doc), 4);
      expect(await docIsCovered(db, DOC)).toBe(true);
    });

    it('an overwritten value is a deletion too: it needs the delete set as well as the vector', async () => {
      const { doc, rows } = localDoc();
      doc.getMap<unknown>('m').set('k', 1);
      doc.getMap<unknown>('m').set('k', 2);
      await store(rows);
      await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
      expect(await docIsCovered(db, DOC)).toBe(false);
      await recordServerDeleteSet(db, DOC, Y.encodeStateAsUpdate(serverState(rows).doc), 2);
      expect(await docIsCovered(db, DOC)).toBe(true);
    });
  });

  describe('cost bound', () => {
    function bigRows(bytes: number): Uint8Array[] {
      const { doc, rows } = localDoc();
      doc.getText('t').insert(0, 'x'.repeat(bytes));
      return rows;
    }

    it('answers for a document just under the scratch limit', async () => {
      const rows = bigRows(MAX_COVERAGE_SCRATCH_BYTES - 1024);
      await store(rows);
      await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
      expect(await docIsCovered(db, DOC)).toBe(true);
    });

    it('does not load a document over the limit: it is not covered, even when the marker would cover it', async () => {
      const rows = bigRows(MAX_COVERAGE_SCRATCH_BYTES + 1024);
      await store(rows);
      await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
      expect(await docIsCovered(db, DOC)).toBe(false);
    });

    it('does not even read the rows of a document over the limit', async () => {
      const rows = bigRows(MAX_COVERAGE_SCRATCH_BYTES + 1024);
      await store(rows);
      const pages: string[] = [];
      const spy: Db = { ...db, query: (sql, params) => (pages.push(sql), db.query(sql, params)) };
      expect(await docIsCovered(spy, DOC)).toBe(false);
      expect(pages.some((sql) => sql.includes('SELECT id, data'))).toBe(false);
    });

    it('takes the limit from the caller when one is given', async () => {
      const { doc, rows } = localDoc();
      doc.getText('t').insert(0, 'y'.repeat(2000));
      await store(rows);
      await recordServerStateVector(db, DOC, serverState(rows).sv, 1);
      expect(await docIsCovered(db, DOC, { maxBytes: 1000 })).toBe(false);
      expect(await docIsCovered(db, DOC, { maxBytes: 10_000 })).toBe(true);
    });
  });
});
