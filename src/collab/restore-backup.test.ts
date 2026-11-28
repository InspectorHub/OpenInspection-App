import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { backupStateOf, deleteRestoreBackup, listRestoreBackups, readRestoreBackup, saveRestoreBackup } from './restore-backup';

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

function docWithFinding(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap<unknown>('results').set('item-1', 'rated');
  return doc;
}

describe('backupStateOf', () => {
  it('returns null for an empty document: nothing worth a backup, and no notice', () => {
    expect(backupStateOf(new Y.Doc())).toBeNull();
  });

  it('returns the full state once the document holds anything', () => {
    const doc = docWithFinding();
    const state = backupStateOf(doc);
    expect(state).not.toBeNull();
    const copy = new Y.Doc();
    Y.applyUpdate(copy, state as Uint8Array);
    expect(copy.getMap<unknown>('results').get('item-1')).toBe('rated');
  });
});

describe('the one backup slot', () => {
  it('saves and reads a copy back, byte for byte', async () => {
    const state = backupStateOf(docWithFinding()) as Uint8Array;
    await saveRestoreBackup(db, 'results-insp-1', state, 1_000);
    const read = await readRestoreBackup(db, 'results-insp-1');
    expect(read).not.toBeNull();
    expect(read?.docName).toBe('results-insp-1');
    expect(read?.createdAt).toBe(1_000);
    expect(read?.reason).toBe('restore');
    expect(Array.from(read?.data ?? [])).toEqual(Array.from(state));
  });

  it('returns null when no copy was saved', async () => {
    expect(await readRestoreBackup(db, 'results-insp-1')).toBeNull();
  });

  it('the next restore overwrites the slot instead of piling up', async () => {
    const first = backupStateOf(docWithFinding()) as Uint8Array;
    await saveRestoreBackup(db, 'results-insp-1', first, 1_000);
    const secondDoc = docWithFinding();
    secondDoc.getMap<unknown>('results').set('item-2', 'noted');
    const second = backupStateOf(secondDoc) as Uint8Array;
    await saveRestoreBackup(db, 'results-insp-1', second, 2_000);
    const read = await readRestoreBackup(db, 'results-insp-1');
    expect(read?.createdAt).toBe(2_000);
    expect(Array.from(read?.data ?? [])).toEqual(Array.from(second));
    expect(await listRestoreBackups(db)).toHaveLength(1);
  });

  it('copies of different inspections do not overwrite each other', async () => {
    await saveRestoreBackup(db, 'results-insp-1', backupStateOf(docWithFinding()) as Uint8Array, 1_000);
    await saveRestoreBackup(db, 'results-insp-2', backupStateOf(docWithFinding()) as Uint8Array, 2_000);
    expect(await listRestoreBackups(db)).toHaveLength(2);
  });

  it('deleting a copy leaves the others', async () => {
    await saveRestoreBackup(db, 'results-insp-1', backupStateOf(docWithFinding()) as Uint8Array, 1_000);
    await saveRestoreBackup(db, 'results-insp-2', backupStateOf(docWithFinding()) as Uint8Array, 2_000);
    await deleteRestoreBackup(db, 'results-insp-1');
    expect(await readRestoreBackup(db, 'results-insp-1')).toBeNull();
    expect(await readRestoreBackup(db, 'results-insp-2')).not.toBeNull();
  });

  it('refuses a document name that could not be one', async () => {
    await expect(saveRestoreBackup(db, "results-x' OR 1=1 --", new Uint8Array([1]), 1)).rejects.toThrow(RangeError);
    await expect(readRestoreBackup(db, "results-x' OR 1=1 --")).rejects.toThrow(RangeError);
    await expect(deleteRestoreBackup(db, "results-x' OR 1=1 --")).rejects.toThrow(RangeError);
  });
});
