import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { accountKey, type Account } from './outbox';
import { packagesWithError, readPackageStates, upsertListed } from './package-targets';
import {
  GLOBAL_PACKAGE_ID,
  cacheBytes,
  clearRefreshError,
  evictOverCap,
  recordRefreshError,
  refreshErrorKey,
  replaceInspectionResources,
  type StagedResource,
} from './resource-cache';

const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };
const A = accountKey(ALICE);
const B = accountKey(BOB);

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

async function addPackage(id: string, options: { account?: Account; gen?: number; purging?: number; pinned?: number; confirmed?: number; quarantine?: string | null } = {}): Promise<void> {
  const account = options.account ?? ALICE;
  await db.run(
    'INSERT INTO work_package (inspection_id, refreshed_at, tenant_id, user_id, package_gen, purging, pinned, server_confirmed, quarantine_source) VALUES (?, 5, ?, ?, ?, ?, ?, ?, ?)',
    [id, account.tenantId, account.userId, options.gen ?? 0, options.purging ?? 0, options.pinned ?? 0, options.confirmed ?? 1, options.quarantine ?? null],
  );
}

const stage = (...entries: [string, string][]): Map<string, StagedResource> => new Map(entries.map(([key, body]) => [key, { body, fetchedAt: 100 }]));
const markers = async (): Promise<{ key: string; body: string; package_id: string }[]> =>
  db.query<{ key: string; body: string; package_id: string }>("SELECT key, body, package_id FROM resource_cache WHERE SUBSTR(key, 1, 15) = '$refresh_error:' ORDER BY key");
const record = (inspectionId: string, code: string, at = 10, account: string = A): Promise<void> => recordRefreshError(db, { accountKey: account, inspectionId, code, at });

describe('the refresh-error marker is one row per inspection', () => {
  it('two failing inspections leave two markers, and a second failure of one does not erase the other', async () => {
    await addPackage('i1');
    await addPackage('i2');
    await record('i1', 'refused');
    await record('i2', 'server_error');
    expect(await markers()).toEqual([
      { key: '$refresh_error:i1', body: 'refused', package_id: 'i1' },
      { key: '$refresh_error:i2', body: 'server_error', package_id: 'i2' },
    ]);
    await record('i2', 'network');
    expect((await markers()).map((m) => [m.package_id, m.body])).toEqual([
      ['i1', 'refused'],
      ['i2', 'network'],
    ]);
  });

  it('readPackageStates and packagesWithError report both, each with its own code', async () => {
    await addPackage('i1');
    await addPackage('i2');
    await addPackage('i3');
    await record('i1', 'refused');
    await record('i2', 'too_large');
    const states = await readPackageStates(db, ALICE);
    expect(states.map((s) => [s.inspectionId, s.lastError])).toEqual([
      ['i1', 'refused'],
      ['i2', 'too_large'],
      ['i3', null],
    ]);
    expect([...(await packagesWithError(db, ALICE))].sort()).toEqual(['i1', 'i2']);
    expect(states.every((s) => s.cachedResources === 0)).toBe(true);
  });

  it('a marker is not a cached resource, in the count of one package or in the next', async () => {
    await addPackage('i1');
    await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', '{}'], ['/api/inspections/i1/results', '{}']), refreshedAt: 1 });
    await record('i1', 'network');
    expect((await readPackageStates(db, ALICE))[0]).toMatchObject({ cachedResources: 2, lastError: 'network' });
  });

  it('a success for one inspection clears only its own marker', async () => {
    await addPackage('i1');
    await addPackage('i2');
    await record('i1', 'refused');
    await record('i2', 'refused');
    expect(await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', '{}']), refreshedAt: 9 })).toBe('replaced');
    expect((await markers()).map((m) => m.package_id)).toEqual(['i2']);
    await clearRefreshError(db, A, 'i2');
    expect(await markers()).toEqual([]);
  });

  it('removing a package by its id removes that inspection\'s marker and no other', async () => {
    await addPackage('i1');
    await addPackage('i2');
    await record('i1', 'refused');
    await record('i2', 'refused');
    await db.run('DELETE FROM resource_cache WHERE account_key = ? AND package_id = ?', [A, 'i1']);
    expect((await markers()).map((m) => m.package_id)).toEqual(['i2']);
  });

  it.each([
    ['a package that is not there', async () => undefined],
    ['a package being purged', async () => addPackage('i1', { purging: 1 })],
    ['a package of another account', async () => addPackage('i1', { account: BOB })],
  ])('writes no marker for %s, while the identical call for a live package of this account writes one', async (_name, arrange) => {
    await arrange();
    await record('i1', 'refused');
    expect(await markers()).toEqual([]);
    await db.run('DELETE FROM work_package');
    await addPackage('i1');
    await record('i1', 'refused');
    expect(await markers()).toHaveLength(1);
  });

  it('a marker key can only be built from a valid inspection id', async () => {
    expect(refreshErrorKey('i1')).toBe('$refresh_error:i1');
    for (const bad of ['', 'a/b', '$global', 'x'.repeat(65)]) expect(() => refreshErrorKey(bad)).toThrow(RangeError);
    await expect(record('a/b', 'refused')).rejects.toThrow(RangeError);
  });

  it('a marker alone is never evicted and never counted as something to evict; a package with real rows goes with its marker', async () => {
    await addPackage('only-marker');
    await record('only-marker', 'refused');
    expect(await evictOverCap(db, { accountKey: A, capBytes: 0 })).toEqual({ evicted: [], bytes: await cacheBytes(db, A) });
    expect(await markers()).toHaveLength(1);
    expect(await db.query("SELECT refreshed_at FROM work_package WHERE inspection_id = 'only-marker'")).toEqual([{ refreshed_at: 5 }]);
    await addPackage('with-rows');
    await replaceInspectionResources(db, { accountKey: A, inspectionId: 'with-rows', packageGen: 0, resources: stage(['/api/inspections/with-rows', 'x'.repeat(50)]), refreshedAt: 1 });
    await record('with-rows', 'network');
    const result = await evictOverCap(db, { accountKey: A, capBytes: 0 });
    expect(result.evicted).toEqual(['with-rows']);
    expect((await markers()).map((m) => m.package_id)).toEqual(['only-marker']);
  });

  it('markers of two accounts never meet: the same call for the other account is refused for a package that is not theirs', async () => {
    await addPackage('i1');
    await record('i1', 'refused', 10, B);
    expect(await markers()).toEqual([]);
    expect(await packagesWithError(db, BOB)).toEqual(new Set());
    expect(GLOBAL_PACKAGE_ID).toBe('$global');
  });
});

describe('a replacement re-checks, in its own transaction, that the package may still be refreshed', () => {
  const resources = stage(['/api/inspections/i1', 'new']);
  const attempt = (): Promise<string> => replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources, refreshedAt: 1 });
  const seedOld = async (): Promise<void> => {
    await db.run("INSERT INTO resource_cache (account_key, key, body, fetched_at, package_id) VALUES (?, '/api/inspections/i1', 'old', 1, 'i1')", [A]);
  };

  it.each([
    ['a quarantine', () => db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'i1'")],
    ['a package the server no longer confirms', () => db.run('UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = \'i1\'')],
  ])('writes nothing after %s landed, keeps the old rows and the generation, and the same call without it writes', async (_name, interfere) => {
    await addPackage('i1');
    await seedOld();
    await interfere();
    expect(await attempt()).toBe('not_refreshable');
    expect(await db.query('SELECT body FROM resource_cache')).toEqual([{ body: 'old' }]);
    expect(await db.query('SELECT package_gen, refreshed_at FROM work_package')).toEqual([{ package_gen: 0, refreshed_at: 5 }]);
    await db.run("UPDATE work_package SET quarantine_source = NULL, server_confirmed = 1 WHERE inspection_id = 'i1'");
    expect(await attempt()).toBe('replaced');
    expect(await db.query('SELECT body FROM resource_cache')).toEqual([{ body: 'new' }]);
  });
});

describe('what the server listed does not touch a quarantined package', () => {
  const listed = (scheduledAt: number): Parameters<typeof upsertListed>[2] => new Map([['i1', { scheduledAt, completed: true, today: false }]]);

  it('leaves the schedule fields of a quarantined row alone, and updates the identical row without the quarantine', async () => {
    await addPackage('i1', { quarantine: 'reconcile_missing' });
    await db.run('UPDATE work_package SET scheduled_at = 100, completed = 0');
    await upsertListed(db, ALICE, listed(999));
    expect(await db.query('SELECT scheduled_at, completed FROM work_package')).toEqual([{ scheduled_at: 100, completed: 0 }]);
    await db.run('UPDATE work_package SET quarantine_source = NULL');
    await upsertListed(db, ALICE, listed(999));
    expect(await db.query('SELECT scheduled_at, completed FROM work_package')).toEqual([{ scheduled_at: 999, completed: 1 }]);
  });
});
