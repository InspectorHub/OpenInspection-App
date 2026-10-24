import { beforeEach, describe, expect, it } from 'vitest';
import { resultsDocName } from '../collab/connector';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { accountKey, type Account } from './outbox';
import {
  GLOBAL_PACKAGE_ID,
  cacheBytes,
  evictOverCap,
  readCached,
  readCachedBodies,
  replaceGlobalResources,
  replaceInspectionResources,
  type StagedResource,
} from './resource-cache';
import { failingDb } from './test-support/failing-db';

const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };
const A = accountKey(ALICE);
const B = accountKey(BOB);

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

async function addPackage(id: string, options: { account?: Account | null; gen?: number; purging?: number; pinned?: number; confirmed?: number; quarantine?: string | null } = {}): Promise<void> {
  const account = options.account === undefined ? ALICE : options.account;
  await db.run(
    'INSERT INTO work_package (inspection_id, refreshed_at, tenant_id, user_id, package_gen, purging, pinned, server_confirmed, quarantine_source) VALUES (?, 5, ?, ?, ?, ?, ?, ?, ?)',
    [id, account?.tenantId ?? null, account?.userId ?? null, options.gen ?? 0, options.purging ?? 0, options.pinned ?? 0, options.confirmed ?? 1, options.quarantine ?? null],
  );
}

const stage = (...entries: [string, string][]): Map<string, StagedResource> => new Map(entries.map(([key, body]) => [key, { body, fetchedAt: 100 }]));
const keysOf = async (account: string, packageId: string): Promise<string[]> =>
  (await db.query<{ key: string }>('SELECT key FROM resource_cache WHERE account_key = ? AND package_id = ? ORDER BY key', [account, packageId])).map((r) => r.key);

describe('replaceInspectionResources', () => {
  it('replaces the whole set of an inspection and bumps the generation', async () => {
    await addPackage('i1');
    const first = await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', '{"v":1}'], ['/api/inspections/i1/results', '{"v":1}']), refreshedAt: 900 });
    expect(first).toBe('replaced');
    const second = await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 1, resources: stage(['/api/inspections/i1', '{"v":2}']), refreshedAt: 950 });
    expect(second).toBe('replaced');
    expect(await keysOf(A, 'i1')).toEqual(['/api/inspections/i1']);
    expect((await readCached(db, A, '/api/inspections/i1'))?.body).toBe('{"v":2}');
    expect(await db.query('SELECT package_gen, refreshed_at FROM work_package WHERE inspection_id = ?', ['i1'])).toEqual([{ package_gen: 2, refreshed_at: 950 }]);
  });

  it('keeps the etag and fetch time of each row', async () => {
    await addPackage('i1');
    const resources = new Map<string, StagedResource>([['/api/inspections/i1', { body: '{}', etag: 'W/"x"', fetchedAt: 77 }]]);
    await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources, refreshedAt: 1 });
    expect(await readCached(db, A, '/api/inspections/i1')).toEqual({ etag: 'W/"x"', body: '{}', fetchedAt: 77 });
  });

  it('writes nothing when the package is gone (a purge finished first), and the same call writes when it is there', async () => {
    const resources = stage(['/api/inspections/i1', '{}']);
    expect(await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources, refreshedAt: 1 })).toBe('no_package');
    expect(await db.query('SELECT 1 FROM resource_cache')).toEqual([]);
    await addPackage('i1');
    expect(await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources, refreshedAt: 1 })).toBe('replaced');
  });

  it('writes nothing while the package is being purged, and keeps the rows the purge has not reached yet', async () => {
    await addPackage('i1', { purging: 1 });
    await db.run("INSERT INTO resource_cache (account_key, key, body, fetched_at, package_id) VALUES (?, '/api/inspections/i1', 'old', 1, 'i1')", [A]);
    const outcome = await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', 'new']), refreshedAt: 1 });
    expect(outcome).toBe('purging');
    expect((await readCached(db, A, '/api/inspections/i1'))?.body).toBe('old');
    expect(await db.query('SELECT package_gen FROM work_package')).toEqual([{ package_gen: 0 }]);
  });

  it('the older finisher cannot overwrite a newer refresh', async () => {
    await addPackage('i1');
    const newer = await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', 'newer']), refreshedAt: 2 });
    const older = await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', 'older']), refreshedAt: 3 });
    expect(newer).toBe('replaced');
    expect(older).toBe('stale_generation');
    expect((await readCached(db, A, '/api/inspections/i1'))?.body).toBe('newer');
  });

  it('refuses a package owned by another account, an unowned one, and leaves their rows alone', async () => {
    await addPackage('theirs', { account: BOB });
    await addPackage('nobody', { account: null });
    await db.run("INSERT INTO resource_cache (account_key, key, body, fetched_at, package_id) VALUES (?, '/api/inspections/theirs', 'bob-old', 1, 'theirs')", [B]);
    const resources = stage(['/api/inspections/theirs', 'alice-new']);
    expect(await replaceInspectionResources(db, { accountKey: A, inspectionId: 'theirs', packageGen: 0, resources, refreshedAt: 1 })).toBe('other_account');
    expect(await replaceInspectionResources(db, { accountKey: A, inspectionId: 'nobody', packageGen: 0, resources, refreshedAt: 1 })).toBe('other_account');
    expect((await readCached(db, B, '/api/inspections/theirs'))?.body).toBe('bob-old');
    expect(await readCached(db, A, '/api/inspections/theirs')).toBeNull();
  });

  it('refuses a key that is not an api path, so a refresh marker cannot be planted', async () => {
    await addPackage('i1');
    await expect(replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['$refresh_error', 'x']), refreshedAt: 1 })).rejects.toThrow();
    expect(await db.query('SELECT 1 FROM resource_cache')).toEqual([]);
  });

  it('a failure in the middle rolls the whole inspection back: the old set, the generation and the timestamp are untouched', async () => {
    await addPackage('i1');
    await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', 'old-1'], ['/api/inspections/i1/results', 'old-2']), refreshedAt: 10 });
    const flaky = failingDb(db, /INSERT INTO resource_cache/, 2);
    await expect(
      replaceInspectionResources(flaky, { accountKey: A, inspectionId: 'i1', packageGen: 1, resources: stage(['/api/inspections/i1', 'new-1'], ['/api/inspections/i1/results', 'new-2'], ['/api/inspections/i1/units', 'new-3']), refreshedAt: 20 }),
    ).rejects.toThrow('injected');
    expect(flaky.failures()).toBe(1);
    expect((await readCached(db, A, '/api/inspections/i1'))?.body).toBe('old-1');
    expect((await readCached(db, A, '/api/inspections/i1/results'))?.body).toBe('old-2');
    expect(await db.query('SELECT package_gen, refreshed_at FROM work_package')).toEqual([{ package_gen: 1, refreshed_at: 10 }]);
  });

  it('only deletes its own account rows of the same package id', async () => {
    await addPackage('i1');
    await db.run("INSERT INTO resource_cache (account_key, key, body, fetched_at, package_id) VALUES (?, '/api/inspections/i1', 'bob', 1, 'i1')", [B]);
    await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', 'alice']), refreshedAt: 1 });
    expect((await readCached(db, B, '/api/inspections/i1'))?.body).toBe('bob');
    expect((await readCached(db, A, '/api/inspections/i1'))?.body).toBe('alice');
  });
});

describe('global resources and reads', () => {
  it('replaces the global set in its own transaction and does not touch inspection rows', async () => {
    await addPackage('i1');
    await replaceInspectionResources(db, { accountKey: A, inspectionId: 'i1', packageGen: 0, resources: stage(['/api/inspections/i1', 'kept']), refreshedAt: 1 });
    await replaceGlobalResources(db, { accountKey: A, resources: stage(['/api/tags', 'g1'], ['/api/recommendations', 'g2']) });
    await replaceGlobalResources(db, { accountKey: A, resources: stage(['/api/tags', 'g3']) });
    expect(await keysOf(A, GLOBAL_PACKAGE_ID)).toEqual(['/api/tags']);
    expect((await readCached(db, A, '/api/tags'))?.body).toBe('g3');
    expect((await readCached(db, A, '/api/inspections/i1'))?.body).toBe('kept');
  });

  it('a failed global replacement keeps the previous set', async () => {
    await replaceGlobalResources(db, { accountKey: A, resources: stage(['/api/tags', 'old']) });
    await expect(replaceGlobalResources(failingDb(db, /INSERT INTO resource_cache/, 1), { accountKey: A, resources: stage(['/api/tags', 'new']) })).rejects.toThrow('injected');
    expect((await readCached(db, A, '/api/tags'))?.body).toBe('old');
  });

  it('two accounts never see or overwrite each other for the same key', async () => {
    await replaceGlobalResources(db, { accountKey: A, resources: stage(['/api/tags', 'alice']) });
    await replaceGlobalResources(db, { accountKey: B, resources: stage(['/api/tags', 'bob']) });
    expect((await readCached(db, A, '/api/tags'))?.body).toBe('alice');
    expect((await readCached(db, B, '/api/tags'))?.body).toBe('bob');
    expect(await readCached(db, accountKey({ tenantId: 'tenant-2', userId: 'alice' }), '/api/tags')).toBeNull();
  });

  it('readCachedBodies returns only the asked keys of the asked account', async () => {
    await replaceGlobalResources(db, { accountKey: A, resources: stage(['/api/tags', 'a'], ['/api/recommendations', 'b']) });
    await replaceGlobalResources(db, { accountKey: B, resources: stage(['/api/tags', 'bob']) });
    const got = await readCachedBodies(db, A, ['/api/tags', '/api/nothing']);
    expect([...got.keys()]).toEqual(['/api/tags']);
    expect(got.get('/api/tags')?.body).toBe('a');
  });
});

describe('size and eviction', () => {
  it('the Yjs document name the eviction guard looks for is the one the connector writes', () => {
    expect(resultsDocName('abc')).toBe('results-abc');
  });

  async function fill(id: string, bytes: number, fetchedAt: number, account: Account = ALICE): Promise<void> {
    await db.run('INSERT INTO resource_cache (account_key, key, body, fetched_at, package_id) VALUES (?, ?, ?, ?, ?)', [accountKey(account), `/api/inspections/${id}`, 'x'.repeat(bytes), fetchedAt, id]);
  }

  it('counts bytes (not characters) of one account', async () => {
    await db.run("INSERT INTO resource_cache (account_key, key, body, fetched_at, package_id) VALUES (?, '/api/tags', ?, 1, '$global')", [A, 'éé']);
    await fill('i1', 10, 1, BOB);
    expect(await cacheBytes(db, A)).toBe(4);
    expect(await cacheBytes(db, B)).toBe(10);
  });

  it('evicts the oldest clean confirmed unpinned inspection until under the cap, and nothing else', async () => {
    for (const [id, at] of [['old', 1], ['mid', 2], ['new', 3]] as const) {
      await addPackage(id);
      await fill(id, 100, at);
    }
    const result = await evictOverCap(db, { accountKey: A, capBytes: 250 });
    expect(result.evicted).toEqual(['old']);
    expect(await cacheBytes(db, A)).toBe(200);
    expect(await db.query("SELECT refreshed_at FROM work_package WHERE inspection_id = 'old'")).toEqual([{ refreshed_at: 0 }]);
    expect(await db.query('SELECT inspection_id FROM work_package ORDER BY inspection_id')).toHaveLength(3);
  });

  it('does nothing when under the cap', async () => {
    await addPackage('i1');
    await fill('i1', 100, 1);
    expect((await evictOverCap(db, { accountKey: A, capBytes: 100 })).evicted).toEqual([]);
  });

  it.each([
    ['an outbox row of any state', () => db.run("INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, tenant_id, user_id) VALUES ('k', 1, 'inspection.patch', '{}', 'orphaned', 1, 'prot', 'tenant-1', 'alice')")],
    ['a media row of any state', () => db.run("INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES ('m', 'prot', 'photo', 'p', 'image/jpeg', '{}', 'uploaded', 1)")],
    ['a Yjs update', () => db.run("INSERT INTO ydoc_updates (doc_name, data) VALUES ('results-prot', x'00')")],
    ['a pin', () => db.run("UPDATE work_package SET pinned = 1 WHERE inspection_id = 'prot'")],
    ['an unconfirmed (local) package', () => db.run("UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = 'prot'")],
    ['a quarantine', () => db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'prot'")],
    ['a purge in progress', () => db.run("UPDATE work_package SET purging = 1 WHERE inspection_id = 'prot'")],
  ])('never evicts an inspection with %s, while the identical clean one is evicted', async (_name, protect) => {
    await addPackage('prot');
    await fill('prot', 100, 1);
    await addPackage('clean');
    await fill('clean', 100, 2);
    await protect();
    const result = await evictOverCap(db, { accountKey: A, capBytes: 0 });
    expect(result.evicted).toEqual(['clean']);
    expect(await keysOf(A, 'prot')).toHaveLength(1);
  });

  it('never evicts another account, the global set, or a package this account does not own', async () => {
    await addPackage('bobs', { account: BOB });
    await fill('bobs', 100, 1, BOB);
    await addPackage('owned-by-bob', { account: BOB });
    await fill('owned-by-bob', 100, 1, ALICE);
    await replaceGlobalResources(db, { accountKey: A, resources: stage(['/api/tags', 'g']) });
    const result = await evictOverCap(db, { accountKey: A, capBytes: 0 });
    expect(result.evicted).toEqual([]);
    expect(await cacheBytes(db, B)).toBe(100);
    expect((await readCached(db, A, '/api/tags'))?.body).toBe('g');
  });

  it('reports what is left when everything is protected', async () => {
    await addPackage('p', { pinned: 1 });
    await fill('p', 100, 1);
    const result = await evictOverCap(db, { accountKey: A, capBytes: 10 });
    expect(result).toEqual({ evicted: [], bytes: 100 });
  });
});
