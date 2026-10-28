import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { rowCounts } from '../app/test-support/world';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { DEVICE_STATE_KEYS, migrate } from '../platform/schema';
import { clearLocalData, DEVICE_STATE_SURVIVORS, DEVICE_STATE_SURVIVOR_PREFIXES } from './clear-local-data';

const NOW = 1_800_000_000_000;
const DATA_TABLES = ['ydoc_updates', 'media', 'outbox', 'resource_cache', 'item_tags', 'work_package'] as const;
let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

async function seed(): Promise<void> {
  await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['i1', new Uint8Array([1])]);
  await db.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at) VALUES (?, ?, ?, ?, ?)', ['t%3Au', 'k', 'e', '{}', 1]);
  await db.run('INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['o1', 1, 'save', '{}', 'pending', 1]);
  await db.run('INSERT INTO work_package (inspection_id, refreshed_at) VALUES (?, ?)', ['i1', 1]);
  await db.run("INSERT INTO item_tags (account_key, inspection_id, item_id, tag_id, name, color, state, updated_at) VALUES ('t%3Au', 'i1', 'item-1', 'tag-1', 'Urgent', NULL, 'add', 1)");
  for (const [id, path] of [
    ['m1', 'media/m1.jpg'],
    ['m2', 'media/m2.jpg'],
    ['m3', 'media/m3.mp4'],
  ] as const) {
    await db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, 'i1', 'photo', path, 'image/jpeg', '{}', 'pending', 1]);
  }
  for (const key of DEVICE_STATE_KEYS) await db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', [key, `v-${key}`]);
  await db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', ['client_id:https://oi.example.test', 'client-1']);
  await db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', ['client_id:https://other.example.test', 'client-2']);
}

async function stateKeys(): Promise<string[]> {
  return (await db.query<{ key: string }>('SELECT key FROM device_state ORDER BY key')).map((r) => r.key);
}

describe('clearLocalData', () => {
  it('deletes every data table and the native files, and reports nothing failed', async () => {
    await seed();
    const files = createMemoryFiles({ 'media/m1.jpg': new Uint8Array([1]), 'media/m2.jpg': new Uint8Array([2]), 'media/m3.mp4': new Uint8Array([3]), 'media/unrelated.jpg': new Uint8Array([4]) });
    const result = await clearLocalData(db, files, NOW);
    const counts = await rowCounts(db);
    for (const table of DATA_TABLES) expect(counts[table]).toBe(0);
    // A file the store would have written with no row is an orphan and goes too (an intended change: it used to stay).
    expect(files.paths()).toEqual([]);
    expect(result).toEqual({ filesRemoved: 4, filesFailed: [] });
  });

  it('keeps exactly server_url, device_id, install_marker and the client_id:* registrations', async () => {
    await seed();
    await clearLocalData(db, createMemoryFiles(), NOW);
    expect(await stateKeys()).toEqual(['client_id:https://oi.example.test', 'client_id:https://other.example.test', 'device_id', 'install_marker', 'server_url']);
  });

  it('the survivor list is declared device_state keys and everything else is removed (identity, lock marks, verification)', async () => {
    expect([...DEVICE_STATE_SURVIVORS].sort()).toEqual(['device_id', 'install_marker', 'server_url']);
    expect(DEVICE_STATE_SURVIVOR_PREFIXES).toEqual(['client_id:']);
    for (const key of ['user_id', 'tenant_id', 'role', 'tenant_name', 'last_verified_at', 'max_seen_time', 'offline_max_days', 'locked_reason', 'sync_days']) {
      expect(DEVICE_STATE_KEYS).toContain(key);
      expect(DEVICE_STATE_SURVIVORS as readonly string[]).not.toContain(key);
    }
    for (const key of DEVICE_STATE_SURVIVORS) expect(DEVICE_STATE_KEYS as readonly string[]).toContain(key);
  });

  it('a file that cannot be removed does not stop the others, is reported, and its row is still deleted', async () => {
    await seed();
    const files = createMemoryFiles({ 'media/m1.jpg': new Uint8Array([1]), 'media/m2.jpg': new Uint8Array([2]), 'media/m3.mp4': new Uint8Array([3]) });
    files.failRemoveFor('media/m2.jpg');
    const result = await clearLocalData(db, files, NOW);
    expect(files.paths()).toEqual(['media/m2.jpg']);
    expect(result).toEqual({ filesRemoved: 2, filesFailed: ['media/m2.jpg'] });
    expect((await rowCounts(db)).media).toBe(0);
  });

  it('control: with no failure the same call reports an empty failure list', async () => {
    await seed();
    const result = await clearLocalData(db, createMemoryFiles({ 'media/m1.jpg': new Uint8Array([1]), 'media/m2.jpg': new Uint8Array([2]), 'media/m3.mp4': new Uint8Array([3]) }), NOW);
    expect(result.filesFailed).toEqual([]);
  });

  it('a file that is already missing is reported but never blocks the rest', async () => {
    await seed();
    const files = createMemoryFiles({ 'media/m1.jpg': new Uint8Array([1]), 'media/m3.mp4': new Uint8Array([3]) });
    const result = await clearLocalData(db, files, NOW);
    expect(result).toEqual({ filesRemoved: 2, filesFailed: ['media/m2.jpg'] });
    expect(files.removeCalls()).toEqual(['media/m1.jpg', 'media/m2.jpg', 'media/m3.mp4']);
  });

  it('an empty device clears to an empty device', async () => {
    expect(await clearLocalData(db, createMemoryFiles(), NOW)).toEqual({ filesRemoved: 0, filesFailed: [] });
  });

  it('is repeatable: a second run changes nothing', async () => {
    await seed();
    await clearLocalData(db, createMemoryFiles(), NOW);
    const keys = await stateKeys();
    await clearLocalData(db, createMemoryFiles(), NOW);
    expect(await stateKeys()).toEqual(keys);
  });

  it('a database failure part-way leaves device_state (and so the lock marks) in place', async () => {
    await seed();
    const failing: Db = {
      ...db,
      run: (sql, params) => (sql.includes('FROM outbox') ? Promise.reject(new Error('disk I/O error')) : db.run(sql, params)),
    };
    await expect(clearLocalData(failing, createMemoryFiles(), NOW)).rejects.toThrow('disk I/O error');
    expect(await stateKeys()).toContain('locked_reason');
    expect(await stateKeys()).toContain('user_id');
  });
});
