import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { MAX_COVERED_STATE_BYTES, MAX_DOC_NAME_LENGTH, readSyncMarker, writeSyncMarker } from './sync-marker';

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

describe('the synced-state marker', () => {
  it('is absent until something wrote it: no marker means the server may not have the document', async () => {
    expect(await readSyncMarker(db, 'insp-1')).toBeNull();
  });

  it('round-trips the acknowledged state and its time', async () => {
    await writeSyncMarker(db, 'insp-1', new Uint8Array([1, 2, 3]), 1000);
    const marker = await readSyncMarker(db, 'insp-1');
    expect(marker?.updatedAt).toBe(1000);
    expect([...(marker?.coveredState ?? [])]).toEqual([1, 2, 3]);
  });

  it('replaces the earlier marker of the same document and leaves other documents alone', async () => {
    await writeSyncMarker(db, 'insp-1', new Uint8Array([1]), 1);
    await writeSyncMarker(db, 'insp-2', new Uint8Array([9]), 1);
    await writeSyncMarker(db, 'insp-1', new Uint8Array([2, 2]), 2);
    expect([...((await readSyncMarker(db, 'insp-1'))?.coveredState ?? [])]).toEqual([2, 2]);
    expect([...((await readSyncMarker(db, 'insp-2'))?.coveredState ?? [])]).toEqual([9]);
    expect(await db.query('SELECT count(*) AS n FROM ydoc_sync')).toEqual([{ n: 2 }]);
  });

  it('treats a row without a state as no marker', async () => {
    await db.run('INSERT INTO ydoc_sync (doc_name, covered_state, updated_at) VALUES (?, NULL, ?)', ['insp-1', 5]);
    expect(await readSyncMarker(db, 'insp-1')).toBeNull();
  });

  it('refuses an empty or oversize name, and an empty or oversize state', async () => {
    await expect(writeSyncMarker(db, '', new Uint8Array([1]), 1)).rejects.toThrow(/name/);
    await expect(writeSyncMarker(db, 'x'.repeat(MAX_DOC_NAME_LENGTH + 1), new Uint8Array([1]), 1)).rejects.toThrow(/name/);
    await expect(readSyncMarker(db, '')).rejects.toThrow(/name/);
    await expect(writeSyncMarker(db, 'insp-1', new Uint8Array(0), 1)).rejects.toThrow(/state/);
    await expect(writeSyncMarker(db, 'insp-1', new Uint8Array(MAX_COVERED_STATE_BYTES + 1), 1)).rejects.toThrow(/state/);
    await writeSyncMarker(db, 'x'.repeat(MAX_DOC_NAME_LENGTH), new Uint8Array(MAX_COVERED_STATE_BYTES), 1);
    expect(await db.query('SELECT count(*) AS n FROM ydoc_sync')).toEqual([{ n: 1 }]);
  });
});
