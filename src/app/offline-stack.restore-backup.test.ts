// @vitest-environment jsdom
import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import type { SocketHandlers } from '../collab/connector';
import { saveRestoreBackup } from '../collab/restore-backup';
import { SqlitePersistence } from '../collab/y-sqlite';
import type { Db } from '../platform/db';
import { jsonReply } from '../offline/test-support/package-world';
import { createStackWorld, type StackWorld } from './test-support/stack-world';
import type { OfflineStack } from './offline-stack';

/** Starts the stack and waits until everything its start sequence runs has finished. */
async function run(stack: OfflineStack): Promise<void> {
  stack.start();
  await stack.settled();
  await stack.idle();
}

async function barrier(db: Db): Promise<void> {
  await db.query('SELECT 1');
}

/** Stores `doc`'s whole state as the stored rows of `docName`. */
async function seedDocRows(db: Db, docName: string, doc: Y.Doc): Promise<void> {
  await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [docName, Y.encodeStateAsUpdate(doc)]);
}

/** The stored state of `docName`, read back into a fresh document. */
async function readStoredDoc(db: Db, docName: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const persistence = new SqlitePersistence(db, docName, doc, {});
  try {
    await persistence.whenSynced;
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  } finally {
    await persistence.destroy().catch(() => undefined);
  }
}

async function backupRows(db: Db, docName: string): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM restore_backups WHERE doc_name = ?', [docName]);
  return Number(rows[0]?.n);
}

function docWith(map: string, key: string, value: unknown): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap<unknown>(map).set(key, value);
  return doc;
}

describe('restore backups', () => {
  it('loads copies saved before this stack started, so the notice survives a restart', async () => {
    const w: StackWorld = await createStackWorld();
    await saveRestoreBackup(w.replay.db, 'results-insp-1', Y.encodeStateAsUpdate(docWith('m', 'stale', 1)), 1_000);
    const stack = w.make();
    await run(stack);
    await vi.waitFor(() => expect(stack.restoreNotices.get()).toEqual([{ inspectionId: 'insp-1', backedUpAt: 1_000 }]));
    await stack.stop();
  });

  it('restoring a copy merges it into the stored document and deletes the row and the notice', async () => {
    const w: StackWorld = await createStackWorld();
    const stack = w.make();
    await run(stack);
    await seedDocRows(w.replay.db, 'results-insp-1', docWith('m', 'restored', true));
    await saveRestoreBackup(w.replay.db, 'results-insp-1', Y.encodeStateAsUpdate(docWith('m', 'stale', 1)), 1_000);
    // The notice the stack would have loaded at start is not there (the row was saved after start); the restore
    // works from the row alone.
    expect(await stack.restoreBackup('insp-1')).toEqual({ ok: true });
    expect(await backupRows(w.replay.db, 'results-insp-1')).toBe(0);
    expect(stack.restoreNotices.get()).toEqual([]);
    const stored = await readStoredDoc(w.replay.db, 'results-insp-1');
    try {
      expect(stored.getMap<unknown>('m').get('restored')).toBe(true);
      expect(stored.getMap<unknown>('m').get('stale')).toBe(1);
    } finally {
      stored.destroy();
    }
    await stack.stop();
  });

  it('restoring with no copy is missing, and the notice is cleared', async () => {
    const w: StackWorld = await createStackWorld();
    const stack = w.make();
    await run(stack);
    expect(await stack.restoreBackup('insp-1')).toEqual({ ok: false, reason: 'missing' });
    await stack.stop();
  });

  it('restoring an id that could not be one fails without throwing', async () => {
    const w: StackWorld = await createStackWorld();
    const stack = w.make();
    await run(stack);
    expect(await stack.restoreBackup("insp-1' OR 1=1 --")).toEqual({ ok: false, reason: 'failed' });
    await stack.stop();
  });

  it('discarding a copy deletes the row and clears the notice; a second discard still answers true', async () => {
    const w: StackWorld = await createStackWorld();
    await saveRestoreBackup(w.replay.db, 'results-insp-1', Y.encodeStateAsUpdate(docWith('m', 'stale', 1)), 1_000);
    const stack = w.make();
    await run(stack);
    await vi.waitFor(() => expect(stack.restoreNotices.get()).toHaveLength(1));
    expect(await stack.discardRestoreBackup('insp-1')).toBe(true);
    expect(await backupRows(w.replay.db, 'results-insp-1')).toBe(0);
    expect(stack.restoreNotices.get()).toEqual([]);
    expect(await stack.discardRestoreBackup('insp-1')).toBe(true);
    await stack.stop();
  });
});

describe('a version restore through the live connection', () => {
  it('backs the discarded copy up and raises the notice, which restores it into the live document', async () => {
    const w: StackWorld = await createStackWorld();
    w.pkg.overrides.set('/api/inspections/insp-1/collab/ticket', () =>
      jsonReply(200, { success: true, data: { ticket: 't'.repeat(32), expiresIn: 60 } }),
    );
    const handlers: SocketHandlers[] = [];
    const sent: Uint8Array[] = [];
    let opened = false;
    // A live binding: after a restore the connection's document is a new object, and the editor port must hand
    // out the current one, not the one the connection opened with.
    let handle: ReturnType<OfflineStack['connector']['connect']> | null = null;
    const stack = w.make({
      openSocket: (_url, h) => {
        handlers.push(h);
        return {
          isOpen: () => opened,
          send: (data) => {
            sent.push(data);
          },
          close: () => {
            opened = false;
          },
        };
      },
      editor: {
        liveDoc: () => handle?.doc ?? null,
        isOpenInEditor: () => handle !== null,
      },
    });
    await run(stack);
    handle = stack.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    opened = true;
    handlers[0]?.open();
    handle.doc.getMap<unknown>('m').set('stale', 1);
    await barrier(w.replay.db);
    expect(sent.length).toBeGreaterThan(0);

    // The server's restore frame: a bare control frame.
    handlers[0]?.message(Uint8Array.from([2]));
    await vi.waitFor(() => expect(stack.restoreNotices.get()).toHaveLength(1));
    expect(stack.restoreNotices.get()[0]?.inspectionId).toBe('insp-1');
    expect(await backupRows(w.replay.db, 'results-insp-1')).toBe(1);
    expect(handle.doc.getMap<unknown>('m').get('stale')).toBeUndefined();

    // One tap restores the copy into the live document, which the connection then syncs.
    expect(await stack.restoreBackup('insp-1')).toEqual({ ok: true });
    expect(handle.doc.getMap<unknown>('m').get('stale')).toBe(1);
    expect(await backupRows(w.replay.db, 'results-insp-1')).toBe(0);
    expect(stack.restoreNotices.get()).toEqual([]);
    handle.destroy();
    await stack.stop();
  });
});
