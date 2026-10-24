import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { blockedState, createBlockedGuard } from './blocked';

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

async function pkg(id: string, purging: number, quarantine: string | null): Promise<void> {
  await db.run('INSERT INTO work_package (inspection_id, refreshed_at, purging, quarantine_source) VALUES (?, 1, ?, ?)', [id, purging, quarantine]);
}

describe('blockedState', () => {
  it('reads none, quarantined and purging from the package row', async () => {
    await pkg('plain', 0, null);
    await pkg('held', 0, 'reconcile_missing');
    await pkg('going', 1, null);
    expect(await blockedState(db, 'plain')).toBe('none');
    expect(await blockedState(db, 'held')).toBe('quarantined');
    expect(await blockedState(db, 'going')).toBe('purging');
  });

  it('purging wins over a quarantine on the same row', async () => {
    await pkg('both', 1, 'reconcile_missing');
    expect(await blockedState(db, 'both')).toBe('purging');
  });

  it('an inspection without a package row is not blocked', async () => {
    expect(await blockedState(db, 'unknown')).toBe('none');
  });

  it('a quarantine source nobody knows still blocks', async () => {
    await pkg('odd', 0, 'something_new');
    expect(await blockedState(db, 'odd')).toBe('quarantined');
  });

  it('an id that could not be an inspection id is refused', async () => {
    await expect(blockedState(db, 'a/b')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('the guard', () => {
  it('answers true for a blocked inspection and false for the same state without the flag', async () => {
    await pkg('plain', 0, null);
    await pkg('held', 0, 'reconcile_missing');
    await pkg('going', 1, null);
    const isBlocked = createBlockedGuard(db);
    expect(await isBlocked('plain')).toBe(false);
    expect(await isBlocked('held')).toBe(true);
    expect(await isBlocked('going')).toBe(true);
  });

  it('follows the row: clearing the flag unblocks, setting it blocks, with no cache in between', async () => {
    await pkg('x', 0, null);
    const isBlocked = createBlockedGuard(db);
    expect(await isBlocked('x')).toBe(false);
    await db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'x'");
    expect(await isBlocked('x')).toBe(true);
    await db.run('UPDATE work_package SET quarantine_source = NULL WHERE inspection_id = ?', ['x']);
    expect(await isBlocked('x')).toBe(false);
  });

  it('fails closed: a read that throws counts as blocked', async () => {
    const broken: Db = { ...db, query: () => Promise.reject(new Error('storage unreadable')) };
    expect(await createBlockedGuard(broken)('anything')).toBe(true);
  });

  it('fails closed for an id that is not an inspection id', async () => {
    expect(await createBlockedGuard(db)('../etc')).toBe(true);
    expect(await createBlockedGuard(db)('')).toBe(true);
  });

  it('control: the same guard on a healthy database and a valid id does not block', async () => {
    expect(await createBlockedGuard(db)('valid-id')).toBe(false);
  });
});
