import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { clearLocalData } from './clear-local-data';

const NOW = 1_800_000_000_000;
let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

const bytes = new Uint8Array([1, 2, 3]);

describe('clearing the device removes what a crash left behind', () => {
  it('removes an export archive left in the cache, of any age, including one from a crashed export (control: other cache files stay)', async () => {
    const files = createMemoryFiles();
    files.seedCache(`inspectorhub-export-${String(NOW - 60_000)}.zip`, NOW - 60_000);
    files.seedCache(`inspectorhub-export-${String(NOW - 86_400_000)}.zip`, NOW - 86_400_000);
    files.seedCache('some-other-app-file.zip', NOW - 60_000);
    files.seedCache('inspectorhub-export-notes.txt', NOW - 60_000);
    await clearLocalData(db, files, NOW);
    expect(files.cacheNames().sort()).toEqual(['inspectorhub-export-notes.txt', 'some-other-app-file.zip']);
  });

  it('removes a photo file no row refers to, whatever its age, and leaves names the store never writes alone', async () => {
    const files = createMemoryFiles({ 'media/orphan1.jpg': bytes, 'media/orphan2.mp4': bytes, 'media/readme.txt': bytes, 'media/sub dir.jpg': bytes, 'other/keep.jpg': bytes });
    const result = await clearLocalData(db, files, NOW);
    expect(await files.list('media').then((entries) => entries.map((e) => e.name).sort())).toEqual(['readme.txt', 'sub dir.jpg']);
    expect(await files.exists('other/keep.jpg')).toBe(true);
    expect(result.filesRemoved).toBe(2);
    expect(result.filesFailed).toEqual([]);
  });

  it('a leftover file that cannot be removed is reported with its stored path', async () => {
    const files = createMemoryFiles({ 'media/stuck.jpg': bytes });
    files.failRemoveFor('media/stuck.jpg');
    const result = await clearLocalData(db, files, NOW);
    expect(result.filesFailed).toEqual(['media/stuck.jpg']);
  });

  it('a media directory that cannot be listed, or a cache that cannot be listed, does not stop the clear', async () => {
    const files = createMemoryFiles({ 'media/a.jpg': bytes });
    files.failListCache();
    await db.run('INSERT INTO work_package (inspection_id, refreshed_at) VALUES (?, ?)', ['i1', 1]);
    await expect(clearLocalData(db, files, NOW)).resolves.toBeDefined();
    expect(await db.query('SELECT 1 FROM work_package')).toEqual([]);
  });
});
