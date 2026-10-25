import { beforeEach, describe, expect, it } from 'vitest';
import { accountKey } from '../../offline/outbox';
import { at, ALICE, BOB, createListWorld, NOW, seedCached, seedMedia, seedPkg, seedQueued, seedRefreshError, seedTenantName, type ListWorld } from '../test-support/worklist-world';
import { readWorkListSnapshot } from './model';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});

const snapshot = () => readWorkListSnapshot(w.stack, NOW);
const row = async (id: string) => (await snapshot()).rows.find((r) => r.id === id);

describe('readWorkListSnapshot: rows come from the database', () => {
  it("reads only this account's packages", async () => {
    await seedPkg(w.db, { id: 'mine' });
    await seedPkg(w.db, { id: 'theirs', owner: BOB });
    expect((await snapshot()).rows.map((r) => r.id)).toEqual(['mine']);
  });

  it('downloaded means cached resources exist; the title is the cached address, truncated to 120 characters', async () => {
    await seedPkg(w.db, { id: 'a', refreshedAt: NOW - 60_000 });
    await seedCached(w.db, 'a', 'x'.repeat(200));
    await seedPkg(w.db, { id: 'b' });
    const a = await row('a');
    const b = await row('b');
    expect(a?.downloaded).toBe(true);
    expect(a?.title).toBe(`${'x'.repeat(119)}…`);
    expect(b?.downloaded).toBe(false);
    expect(b?.title).toBeNull();
  });

  it('a cached body that is not the expected shape gives no title and never throws', async () => {
    await seedPkg(w.db, { id: 'a' });
    await w.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, '/api/inspections/a', NULL, 'not json', 1, 'a')", [accountKey(ALICE)]);
    await seedPkg(w.db, { id: 'b' });
    await w.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, '/api/inspections/b', NULL, '{\"data\":{\"inspection\":{\"propertyAddress\":42}}}', 1, 'b')", [accountKey(ALICE)]);
    expect((await row('a'))?.title).toBeNull();
    expect((await row('b'))?.title).toBeNull();
  });

  it("pinned, created-on-device, quarantine and purging flags are the package row's", async () => {
    await seedPkg(w.db, { id: 'p', pinned: 1 });
    await seedPkg(w.db, { id: 'c', confirmed: 0 });
    await seedPkg(w.db, { id: 'q', quarantine: 'reconcile_missing' });
    await seedPkg(w.db, { id: 'r', purging: 2 });
    expect(await row('p')).toMatchObject({ pinned: true, createdLocally: false, blocked: 'none' });
    expect(await row('c')).toMatchObject({ createdLocally: true, blocked: 'none' });
    expect(await row('q')).toMatchObject({ blocked: 'quarantined' });
    expect(await row('r')).toMatchObject({ blocked: 'purging' });
  });

  it('purging wins over a quarantine', async () => {
    await seedPkg(w.db, { id: 'x', purging: 1, quarantine: 'reconcile_missing' });
    expect((await row('x'))?.blocked).toBe('purging');
  });

  it('only a confirmed, healthy package can be pinned from the list', async () => {
    await seedPkg(w.db, { id: 'ok' });
    await seedPkg(w.db, { id: 'q', quarantine: 'reconcile_missing' });
    await seedPkg(w.db, { id: 'c', confirmed: 0 });
    await seedPkg(w.db, { id: 'r', purging: 1 });
    expect((await row('ok'))?.canPin).toBe(true);
    expect((await row('q'))?.canPin).toBe(false);
    expect((await row('c'))?.canPin).toBe(false);
    expect((await row('r'))?.canPin).toBe(false);
  });

  it('the last refresh error is a fixed code', async () => {
    await seedPkg(w.db, { id: 'a' });
    await seedRefreshError(w.db, 'a', 'rate_limited');
    await seedPkg(w.db, { id: 'b' });
    await seedRefreshError(w.db, 'b', 'a code nobody defined');
    expect((await row('a'))?.lastError).toBe('rate_limited');
    expect((await row('b'))?.lastError).toBeNull();
  });
});

describe('readWorkListSnapshot: counts', () => {
  it('waiting is queued writes plus photos not yet uploaded; failed ones are counted apart; orphaned apart again', async () => {
    await seedPkg(w.db, { id: 'a' });
    await seedPkg(w.db, { id: 'b' });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a' });
    await seedQueued(w.db, { key: 'k2', seq: 2, inspectionId: 'a' });
    await seedQueued(w.db, { key: 'k3', seq: 3, inspectionId: 'a', state: 'failed', error: 'rejected' });
    await seedQueued(w.db, { key: 'k4', seq: 4, inspectionId: 'a', state: 'orphaned', error: 'target_gone' });
    await seedMedia(w.db, 'm1', 'a', 'pending');
    await seedMedia(w.db, 'm2', 'a', 'uploading');
    await seedMedia(w.db, 'm3', 'a', 'failed');
    await seedMedia(w.db, 'm4', 'a', 'uploaded');
    await seedQueued(w.db, { key: 'k5', seq: 5, inspectionId: 'b' });
    expect(await row('a')).toMatchObject({ waiting: 4, needAttention: 2, orphaned: 1 });
    expect(await row('b')).toMatchObject({ waiting: 1, needAttention: 0, orphaned: 0 });
  });

  it("a queued write of another account is not this account's count", async () => {
    await seedPkg(w.db, { id: 'a' });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', owner: BOB });
    expect((await row('a'))?.waiting).toBe(0);
  });
});

describe('readWorkListSnapshot: groups, failed items, repair list', () => {
  it('groups by scheduled day', async () => {
    await seedPkg(w.db, { id: 't', scheduledAt: at(0) });
    await seedPkg(w.db, { id: 'm', scheduledAt: at(1) });
    await seedPkg(w.db, { id: 'l', scheduledAt: at(4) });
    await seedPkg(w.db, { id: 'e', scheduledAt: at(-2) });
    await seedPkg(w.db, { id: 'u' });
    const rows = (await snapshot()).rows;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.group]))).toEqual({ t: 'today', m: 'tomorrow', l: 'later', e: 'earlier', u: 'unscheduled' });
  });

  it('lists failed queued writes of inspections and stuck photos, with sizes and fixed codes', async () => {
    await seedPkg(w.db, { id: 'a' });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'validation_failed', payload: '{"note":"héllo"}' });
    await seedMedia(w.db, 'm1', 'a', 'failed');
    const snap = await snapshot();
    expect(snap.failedOutbox).toEqual([{ key: 'k1', op: 'inspection.update', inspectionId: 'a', error: 'validation_failed', bytes: 17 }]);
    expect(snap.failedMedia).toEqual([{ pendingId: 'm1', inspectionId: 'a', kind: 'photo' }]);
  });

  it('an unknown error code on a failed write is read as no code', async () => {
    await seedPkg(w.db, { id: 'a' });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'server said: <b>hi</b>' });
    expect((await snapshot()).failedOutbox[0]?.error).toBeNull();
  });

  it('keeps writes that name no inspection out of the per-inspection list and puts them in the repair list', async () => {
    await seedPkg(w.db, { id: 'a' });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: null, state: 'failed', error: 'rejected' });
    await seedQueued(w.db, { key: 'k2', seq: 2, inspectionId: null, owner: BOB });
    const snap = await snapshot();
    expect(snap.failedOutbox).toEqual([]);
    expect(snap.repair.rows.map((r) => r.idempotencyKey)).toEqual(['k1']);
    expect(snap.repair.foreign).toBe(1);
  });

  it('updatedAt is the newest refresh among the packages, and the company name is read for the export wording', async () => {
    await seedPkg(w.db, { id: 'a', refreshedAt: NOW - 600_000 });
    await seedPkg(w.db, { id: 'b', refreshedAt: NOW - 60_000 });
    await seedPkg(w.db, { id: 'c' });
    await seedTenantName(w.db, 'Acme Inspections');
    const snap = await snapshot();
    expect(snap.updatedAt).toBe(NOW - 60_000);
    expect(snap.company).toBe('Acme Inspections');
  });

  it('an empty device reads as no rows, no update time, no company', async () => {
    expect(await snapshot()).toMatchObject({ rows: [], updatedAt: null, company: null, failedOutbox: [], failedMedia: [] });
  });
});
