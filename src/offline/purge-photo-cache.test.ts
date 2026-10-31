import { describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { purgePhotoCopies } from './purge-photo-cache';
import { purgeInspection } from './purge';
import { accountKey } from './outbox';
import { purgeAuthorityForTest } from './test-support/brands';
import { createPurgeWorld } from './test-support/purge-world';
import { ALICE, BOB } from './test-support/reconcile-world';

const hex = (n: number): string => n.toString(16).padStart(64, '0');
const BYTES = new Uint8Array([1, 2, 3]);

async function insert(db: Awaited<ReturnType<typeof createSqlJsDb>>, account: string, inspection: string, n: number, path = `photo-cache/${hex(n)}.jpg`): Promise<void> {
  await db.run('INSERT INTO photo_cache (hash, account_key, inspection_id, key, size, path, bytes, content_type, last_used_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [hex(n), account, inspection, `k${String(n)}`, 'thumb', path, 3, 'image/jpeg', 1, 1]);
}

describe('purgePhotoCopies', () => {
  it('removes the rows and files of one account and inspection and nothing else', async () => {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    const files = createMemoryFiles();
    const a = accountKey(ALICE);
    await insert(db, a, 'p2', 1);
    await insert(db, a, 'p2', 2, `photo-cache/${hex(2)}.webp`);
    await insert(db, a, 'p3', 3);
    await insert(db, accountKey(BOB), 'p2', 4);
    for (const n of [1, 3, 4]) await files.write(`photo-cache/${hex(n)}.jpg`, BYTES);
    await files.write(`photo-cache/${hex(2)}.webp`, BYTES);
    await purgePhotoCopies(db, files, a, 'p2');
    expect(files.paths().sort()).toEqual([`photo-cache/${hex(3)}.jpg`, `photo-cache/${hex(4)}.jpg`]);
    expect((await db.query<{ hash: string }>('SELECT hash FROM photo_cache ORDER BY hash')).map((r) => r.hash)).toEqual([hex(3), hex(4)]);
  });

  it('never deletes a file whose recorded path is not a cache file name (a poisoned row removes only itself)', async () => {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    const files = createMemoryFiles({ 'media/m1.jpg': BYTES });
    await insert(db, accountKey(ALICE), 'p2', 1, 'media/m1.jpg');
    await purgePhotoCopies(db, files, accountKey(ALICE), 'p2');
    expect(files.paths()).toEqual(['media/m1.jpg']);
    expect(await db.query('SELECT 1 FROM photo_cache')).toEqual([]);
  });

  it('a file that will not go does not throw', async () => {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    const files = createMemoryFiles();
    await insert(db, accountKey(ALICE), 'p2', 1);
    await files.write(`photo-cache/${hex(1)}.jpg`, BYTES);
    files.failRemoveFor(`photo-cache/${hex(1)}.jpg`);
    await expect(purgePhotoCopies(db, files, accountKey(ALICE), 'p2')).resolves.toBeUndefined();
  });
});

describe('purging an inspection', () => {
  it('takes its cached photos with it, and leaves another inspection and another account alone', async () => {
    const world = await createPurgeWorld();
    await world.seedFull('p2');
    await world.seedFull('p3');
    const a = accountKey(ALICE);
    await insert(world.db, a, 'p2', 1);
    await insert(world.db, a, 'p3', 2);
    await insert(world.db, accountKey(BOB), 'p2', 3);
    for (const n of [1, 2, 3]) await world.files.write(`photo-cache/${hex(n)}.jpg`, BYTES);
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p2' AND purging = 0 AND quarantine_source IS NULL");
    expect(await purgeInspection(world.purgeDeps(), 'p2', { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest() })).toEqual({ kind: 'purged' });
    expect(world.files.paths().filter((p) => p.startsWith('photo-cache/')).sort()).toEqual([`photo-cache/${hex(2)}.jpg`, `photo-cache/${hex(3)}.jpg`]);
    expect((await world.db.query<{ hash: string }>('SELECT hash FROM photo_cache ORDER BY hash')).map((r) => r.hash)).toEqual([hex(2), hex(3)]);
  });
});
