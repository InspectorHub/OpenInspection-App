import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../auth/errors';
import { recordServerDeleteSet, recordServerStateVector } from '../collab/sync-proof';
import { planIsStale, REASON_MASS_SUSPICIOUS, REASON_NOT_VISIBLE, type ReconcilePlan, type ReconcileResult } from './reconcile-decision';
import { acquireLease, SYNC_LEASE } from './lease';
import { ALICE, BOB, DATA_TABLES, TOKEN, jsonReply, seedEveryTable, seedPackages, createReconcileWorld, visibleReply, type ReconcileWorld } from './test-support/reconcile-world';

let world: ReconcileWorld;

beforeEach(async () => {
  world = await createReconcileWorld();
});

function plan(result: ReconcileResult): Extract<ReconcileResult, { kind: 'plan' }> {
  if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
  return result;
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

/** The server shows everything except the given ids. */
function hide(...ids: string[]): void {
  for (const id of ids) world.server.hidden.add(id);
}

/** A database whose reads fire `onRead` when a statement contains `fragment`, inside transactions as well. */
function watching(fragment: string, onRead: () => void) {
  const wrap = (inner: typeof world.db): typeof world.db => ({
    ...inner,
    query: (sql, params) => {
      if (sql.includes(fragment)) onRead();
      return inner.query(sql, params);
    },
    transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(world.db);
}

describe('the decision for a missing inspection', () => {
  it('purges nothing and keeps everything the server lists', async () => {
    const ids = await seedPackages(world, 3);
    const result = plan(await world.decide());
    expect(result.purge).toEqual([]);
    expect(result.quarantine).toEqual([]);
    expect(sorted(result.keep)).toEqual(ids);
    expect(world.visibleRequests).toEqual([ids]);
    expect(world.sessionRequests).toBe(1);
  });

  it('a missing inspection with nothing unsent is purged', async () => {
    await seedPackages(world, 10);
    hide('p003');
    const result = plan(await world.decide());
    expect(result.purge).toEqual(['p003']);
    expect(result.quarantine).toEqual([]);
    expect(result.massSuspicious).toBe(false);
    expect(result.keep).toHaveLength(9);
  });

  it.each([
    ['a pending queued write', () => world.outbox('p003', 'pending')],
    ['a failed queued write', () => world.outbox('p003', 'failed')],
    ['an orphaned queued write', () => world.outbox('p003', 'orphaned')],
    ['a photo waiting for upload', () => world.media('p003', 'pending')],
    ['a photo that is uploaded but not yet placed', () => world.media('p003', 'uploaded')],
    ['a photo in a state nobody knows', () => world.media('p003', 'mystery')],
    ['edits of the results document the server may not have', () => world.ydoc('p003')],
  ])('a missing inspection with %s is quarantined, never purged', async (_name, setup) => {
    await seedPackages(world, 10);
    await setup();
    hide('p003');
    const result = plan(await world.decide());
    expect(result.quarantine).toEqual(['p003']);
    expect(result.purge).toEqual([]);
    expect(result.proof.unsent.p003?.length).toBeGreaterThan(0);
  });

  it('control: the same inspection with no unsent data and the same answer is purged', async () => {
    await seedPackages(world, 10);
    hide('p003');
    expect(plan(await world.decide()).purge).toEqual(['p003']);
  });

  it('control: unsent data of an inspection the server still lists changes nothing', async () => {
    await seedPackages(world, 10);
    await world.outbox('p003', 'pending');
    const result = plan(await world.decide());
    expect(result.keep).toContain('p003');
    expect(result.quarantine).toEqual([]);
  });

  it('unsent data of another inspection does not save a missing one', async () => {
    await seedPackages(world, 10);
    await world.outbox('p004', 'pending');
    hide('p003');
    expect(plan(await world.decide()).purge).toEqual(['p003']);
  });
});

describe('the results document marker', () => {
  it('edit offline, drop the connection before a covering state vector was observed: quarantine', async () => {
    await seedPackages(world, 10);
    await world.ydoc('p003');
    hide('p003');
    const result = plan(await world.decide());
    expect(result.quarantine).toEqual(['p003']);
    expect(result.purge).toEqual([]);
    expect(result.proof.unsent.p003).toEqual(['ydoc_not_on_server']);
  });

  it('control: the identical rows with a marker that covers them are purged', async () => {
    await seedPackages(world, 10);
    const rows = await world.ydoc('p003');
    await world.cover('p003', rows);
    hide('p003');
    const result = plan(await world.decide());
    expect(result.purge).toEqual(['p003']);
    expect(result.quarantine).toEqual([]);
  });
});

describe('a queued write that belongs to no inspection', () => {
  it('refuses the whole reconcile before any request, and keeps everything', async () => {
    await seedPackages(world, 10);
    await world.outbox(null, 'pending');
    hide('p003');
    const result = await world.decide();
    expect(result).toMatchObject({ kind: 'refused', reason: 'null_inspection_id' });
    expect(world.allRequests).toHaveLength(0);
  });

  it('a row of that kind that appears in flight refuses even when the server lists every inspection', async () => {
    await seedPackages(world, 10);
    world.server.hook = async () => {
      await world.outbox(null, 'pending');
    };
    expect(await world.decide()).toMatchObject({ kind: 'refused', reason: 'null_inspection_id' });
  });

  it('control: without that row the same state yields a plan', async () => {
    await seedPackages(world, 10);
    hide('p003');
    expect(plan(await world.decide()).purge).toEqual(['p003']);
  });

  it('a row of that kind that appears while the request is in flight refuses as well', async () => {
    await seedPackages(world, 10);
    world.server.hook = async () => {
      await world.outbox(null, 'failed');
    };
    hide('p003');
    const result = await world.decide();
    expect(result).toMatchObject({ kind: 'refused', reason: 'null_inspection_id' });
    expect(world.visibleRequests).toHaveLength(1);
  });
});

describe('inspections created on the device', () => {
  it('one that was not acknowledged is never sent and never evaluated, however the server answers', async () => {
    await seedPackages(world, 10);
    await world.pkg('local-1', { confirmed: 0 });
    await world.outbox('local-1', 'pending', { op: 'inspection.create' });
    hide('p003');
    const result = plan(await world.decide());
    expect(world.visibleRequests.flat()).not.toContain('local-1');
    for (const list of [result.purge, result.quarantine, result.keep, result.deferred, result.unquarantine]) expect(list).not.toContain('local-1');
    expect(result.proof.excluded.unconfirmed).toBe(1);
  });

  it('a package with a create still waiting in the queue is not sent either, even if marked confirmed', async () => {
    await seedPackages(world, 10);
    await world.pkg('local-1');
    await world.outbox('local-1', 'pending', { op: 'inspection.create' });
    await world.pkg('local-2');
    await world.outbox('local-2', 'failed', { op: 'inspection.create' });
    const result = plan(await world.decide());
    expect(world.visibleRequests.flat()).not.toContain('local-1');
    expect(world.visibleRequests.flat()).not.toContain('local-2');
    expect(result.proof.excluded.createPending).toBe(2);
  });

  it('control: once the create is acknowledged and its row is gone, the package is asked about like any other', async () => {
    await seedPackages(world, 10);
    await world.pkg('local-1');
    hide('local-1');
    const result = plan(await world.decide());
    expect(world.visibleRequests.flat()).toContain('local-1');
    expect(result.purge).toEqual(['local-1']);
  });

  it('a create replayed while the request is in flight cannot make the package a candidate afterwards', async () => {
    await seedPackages(world, 10);
    await world.pkg('local-1', { confirmed: 0 });
    await world.outbox('local-1', 'pending', { op: 'inspection.create' });
    world.server.hook = async () => {
      await world.db.run("DELETE FROM outbox WHERE inspection_id = 'local-1'");
      await world.db.run("UPDATE work_package SET server_confirmed = 1 WHERE inspection_id = 'local-1'");
    };
    hide('p003');
    const result = plan(await world.decide());
    for (const list of [result.purge, result.quarantine, result.deferred]) expect(list).not.toContain('local-1');
    expect(world.visibleRequests.flat()).not.toContain('local-1');
  });
});

describe('what changes while the request is in flight', () => {
  async function missingWithChange(change: () => Promise<void>): Promise<Extract<ReconcileResult, { kind: 'plan' }>> {
    await seedPackages(world, 10);
    world.server.hook = change;
    hide('p003');
    return plan(await world.decide());
  }

  it('control: with nothing changing the missing inspection is purged', async () => {
    const result = await missingWithChange(() => Promise.resolve());
    expect(result.purge).toEqual(['p003']);
    expect(result.deferred).toEqual([]);
  });

  it.each([
    ['a queued write', () => world.outbox('p003', 'pending')],
    ['a photo', () => world.media('p003', 'pending')],
    ['a results document update', async () => void (await world.ydoc('p003'))],
    ['the quarantine flag', () => world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p003'").then(() => undefined)],
    ['the confirmation flag', () => world.db.run("UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = 'p003'").then(() => undefined)],
    ['the purge tombstone', () => world.db.run("UPDATE work_package SET purging = 1 WHERE inspection_id = 'p003'").then(() => undefined)],
  ])('%s that changes for a missing inspection defers it: it is neither purged nor quarantined', async (_name, change) => {
    const result = await missingWithChange(change);
    expect(result.deferred).toEqual(['p003']);
    expect(result.purge).toEqual([]);
    expect(result.quarantine).toEqual([]);
  });

  it('a change to an inspection that is not part of any action does not defer anything', async () => {
    const result = await missingWithChange(() => world.outbox('p005', 'pending'));
    expect(result.deferred).toEqual([]);
    expect(result.purge).toEqual(['p003']);
    expect(result.keep).toContain('p005');
  });

  it('a queued write that is replayed (its row deleted) while the request is in flight defers the inspection too', async () => {
    await seedPackages(world, 10);
    await world.outbox('p003', 'pending');
    world.server.hook = async () => {
      await world.db.run("DELETE FROM outbox WHERE inspection_id = 'p003'");
    };
    hide('p003');
    const result = plan(await world.decide());
    expect(result.deferred).toEqual(['p003']);
    expect(result.purge).toEqual([]);
  });

  it('data created in flight is seen by the decision even without a fingerprint change elsewhere: a missing inspection with it is never purged', async () => {
    const result = await missingWithChange(() => world.outbox('p003', 'failed'));
    expect(result.purge).toEqual([]);
  });
});

describe('a wrong but valid answer', () => {
  it('6 of 10 missing: every would-be purge becomes a quarantine and the plan says so', async () => {
    await seedPackages(world, 10);
    hide('p001', 'p002', 'p003', 'p004', 'p005', 'p006');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(true);
    expect(result.purge).toEqual([]);
    expect(sorted(result.quarantine)).toEqual(['p001', 'p002', 'p003', 'p004', 'p005', 'p006']);
    expect(result.proof.convertedToQuarantine).toBe(6);
  });

  it('control: 5 of 10 missing is an ordinary reconcile', async () => {
    await seedPackages(world, 10);
    hide('p001', 'p002', 'p003', 'p004', 'p005');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(false);
    expect(sorted(result.purge)).toEqual(['p001', 'p002', 'p003', 'p004', 'p005']);
    expect(result.quarantine).toEqual([]);
  });

  it('control: 5 of 9 is more than half but not more than five', async () => {
    await seedPackages(world, 9);
    hide('p001', 'p002', 'p003', 'p004', 'p005');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(false);
    expect(result.purge).toHaveLength(5);
  });

  it('control: 6 of 12 is exactly half, not more than half', async () => {
    await seedPackages(world, 12);
    hide('p001', 'p002', 'p003', 'p004', 'p005', 'p006');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(false);
    expect(result.purge).toHaveLength(6);
  });

  it('control: 5 of 20 is few', async () => {
    await seedPackages(world, 20);
    hide('p001', 'p002', 'p003', 'p004', 'p005');
    expect(plan(await world.decide()).purge).toHaveLength(5);
  });

  it('7 of 12 is more than half and more than five', async () => {
    await seedPackages(world, 12);
    hide('p001', 'p002', 'p003', 'p004', 'p005', 'p006', 'p007');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(true);
    expect(result.purge).toEqual([]);
  });

  it('every local inspection missing: all are quarantined, even a single one', async () => {
    await seedPackages(world, 3);
    hide('p001', 'p002', 'p003');
    const all = plan(await world.decide());
    expect(all.massSuspicious).toBe(true);
    expect(all.purge).toEqual([]);
    expect(sorted(all.quarantine)).toEqual(['p001', 'p002', 'p003']);

    await world.db.run("DELETE FROM work_package WHERE inspection_id <> 'p001'");
    hide('p001');
    const one = plan(await world.decide());
    expect(one.massSuspicious).toBe(true);
    expect(one.quarantine).toEqual(['p001']);
  });

  it('control: one of two missing is an ordinary purge', async () => {
    await seedPackages(world, 2);
    hide('p001');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(false);
    expect(result.purge).toEqual(['p001']);
  });

  it('an inspection quarantined only by the guard keeps its place when it also has unsent data (no double listing)', async () => {
    await seedPackages(world, 10);
    await world.outbox('p001', 'pending');
    hide('p001', 'p002', 'p003', 'p004', 'p005', 'p006');
    const result = plan(await world.decide());
    expect(result.quarantine.filter((id) => id === 'p001')).toHaveLength(1);
  });

  it('a suspicious answer does not un-quarantine anything', async () => {
    await seedPackages(world, 10, 'p');
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    hide('p001', 'p002', 'p003', 'p004', 'p005', 'p006');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(true);
    expect(result.unquarantine).toEqual([]);
  });

  it('control: the same quarantined inspection listed again by an ordinary answer is un-quarantined', async () => {
    await seedPackages(world, 10, 'p');
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    hide('p001');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(false);
    expect(result.unquarantine).toEqual(['q001']);
  });
});

describe('quarantined and pinned inspections', () => {
  it('a quarantined inspection is asked about, and listed again means un-quarantine', async () => {
    await seedPackages(world, 5);
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    const result = plan(await world.decide());
    expect(world.visibleRequests.flat()).toContain('q001');
    expect(result.unquarantine).toEqual(['q001']);
    expect(result.keep).not.toContain('q001');
  });

  it('a quarantined inspection that is still missing stays where it is and is never purged, even with nothing unsent', async () => {
    await seedPackages(world, 10);
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    hide('q001');
    const result = plan(await world.decide());
    expect(result.purge).toEqual([]);
    expect(result.quarantine).toEqual([]);
    expect(result.keep).toContain('q001');
  });

  it('control: the same inspection without the quarantine flag is purged', async () => {
    await seedPackages(world, 10);
    await world.pkg('q001');
    hide('q001');
    expect(plan(await world.decide()).purge).toEqual(['q001']);
  });

  it('a pinned inspection is asked about and decided like any other', async () => {
    await seedPackages(world, 10);
    await world.pkg('pin-1', { pinned: 1 });
    hide('pin-1');
    const result = plan(await world.decide());
    expect(world.visibleRequests.flat()).toContain('pin-1');
    expect(result.purge).toEqual(['pin-1']);
  });
});

describe('who the packages belong to', () => {
  it('packages of another account or of nobody are never sent, never decided and are named in the plan', async () => {
    await seedPackages(world, 10);
    await world.pkg('bob-1', { account: BOB });
    await world.pkg('nobody-1', { account: null });
    await world.pkg('other-tenant', { account: { tenantId: 'tenant-2', userId: 'alice' } });
    world.server.shows = new Set(['p001']);
    const before = await world.hash();
    const result = plan(await world.decide());
    for (const id of ['bob-1', 'nobody-1', 'other-tenant']) {
      expect(world.visibleRequests.flat()).not.toContain(id);
      for (const list of [result.purge, result.quarantine, result.keep, result.deferred, result.unquarantine]) expect(list).not.toContain(id);
    }
    expect(sorted(result.unknownOwner)).toEqual(['bob-1', 'nobody-1', 'other-tenant']);
    expect(await world.hash()).toBe(before);
  });

  it('control: the same package owned by the signed-in account is asked about and purged when missing', async () => {
    await seedPackages(world, 10);
    await world.pkg('mine-1');
    hide('mine-1');
    expect(plan(await world.decide()).purge).toEqual(['mine-1']);
  });

  it('a session that belongs to somebody else ends the run before any id is sent', async () => {
    await seedPackages(world, 10);
    world.state.sessionIdentity = BOB;
    expect(await world.decide()).toEqual({ kind: 'account_mismatch' });
    expect(world.visibleRequests).toHaveLength(0);
  });

  it('another company with the same user id is another account', async () => {
    await seedPackages(world, 10);
    world.state.sessionIdentity = { tenantId: 'tenant-2', userId: 'alice' };
    expect(await world.decide()).toEqual({ kind: 'account_mismatch' });
    expect(world.visibleRequests).toHaveLength(0);
  });

  it('control: a session that matches the device account proceeds', async () => {
    await seedPackages(world, 10);
    expect((await world.decide()).kind).toBe('plan');
    expect(world.visibleRequests).toHaveLength(1);
  });

  it('no signed-in account: nothing is sent', async () => {
    await seedPackages(world, 10);
    world.state.account = null;
    expect(await world.decide()).toEqual({ kind: 'no_account' });
    expect(world.allRequests).toHaveLength(0);
  });

  it('an account that changes while the request is in flight discards the answer', async () => {
    await seedPackages(world, 10);
    world.server.hook = () => {
      world.state.account = BOB;
    };
    hide('p003');
    expect(await world.decide()).toEqual({ kind: 'account_mismatch' });
  });
});

describe('who is a candidate', () => {
  it('excludes rows being purged and ids that could not be sent, and sends nothing for an empty set', async () => {
    await world.pkg('gone-1', { purging: 1 });
    await world.pkg('bulk');
    await world.pkg('bad id');
    const result = plan(await world.decide());
    expect(world.allRequests).toHaveLength(0);
    expect(result.proof.candidates).toBe(0);
    expect(result.proof.excluded).toMatchObject({ purging: 1, invalidId: 2 });
    for (const list of [result.purge, result.quarantine, result.keep, result.deferred, result.unquarantine]) expect(list).toEqual([]);
  });

  it('control: a valid unconfirmed-free package makes the request happen', async () => {
    await seedPackages(world, 1);
    plan(await world.decide());
    expect(world.visibleRequests).toHaveLength(1);
  });

  it('bounds the number of ids per run and defers the rest', async () => {
    await seedPackages(world, 8);
    const result = plan(await world.decide({ limits: { maxCandidates: 5 } }));
    expect(world.visibleRequests.flat()).toEqual(['p001', 'p002', 'p003', 'p004', 'p005']);
    expect(sorted(result.deferred)).toEqual(['p006', 'p007', 'p008']);
    expect(result.proof.truncated).toBe(true);
  });

  it('control: under the bound nothing is deferred', async () => {
    await seedPackages(world, 5);
    const result = plan(await world.decide({ limits: { maxCandidates: 5 } }));
    expect(result.deferred).toEqual([]);
    expect(result.proof.truncated).toBe(false);
  });
});

describe('batches', () => {
  it.each([
    [1, [1]],
    [300, [300]],
    [301, [300, 1]],
  ])('%i candidates go out as %j', async (count, expected) => {
    await seedPackages(world, count);
    const result = plan(await world.decide());
    expect(world.visibleRequests.map((b) => b.length)).toEqual(expected);
    expect(result.keep).toHaveLength(count);
  });

  it('missing is decided against the union: an id listed by the second batch is not missing', async () => {
    await seedPackages(world, 301);
    world.server.shows = new Set(['p301', ...Array.from({ length: 299 }, (_, i) => `p${String(i + 1).padStart(3, '0')}`)]);
    const result = plan(await world.decide());
    expect(result.proof.missing).toBe(1);
    expect(result.keep).toContain('p301');
  });

  it('a failing second batch yields no plan at all, not even for the first batch', async () => {
    await seedPackages(world, 301);
    world.server.shows = new Set(['p001']);
    world.server.script = [(ids) => visibleReply(ids.filter((id) => id === 'p001')), jsonReply(500, { success: false })];
    const before = await world.hash();
    const result = await world.decide();
    expect(result).toMatchObject({ kind: 'failed', reason: 'server' });
    expect(await world.hash()).toBe(before);
  });

  it('control: the same 301 candidates with both batches answered give a plan', async () => {
    await seedPackages(world, 301);
    expect((await world.decide()).kind).toBe('plan');
  });

  it('a 422 with a smaller limit shrinks once and the run still finishes', async () => {
    await seedPackages(world, 250);
    world.server.script = [jsonReply(422, { success: false, error: { details: { limits: { ids: 100 } } } })];
    const result = plan(await world.decide());
    expect(world.visibleRequests.map((b) => b.length)).toEqual([250, 100, 100, 50]);
    expect(result.keep).toHaveLength(250);
  });

  it('control: a 422 without a usable limit is a failure, never data', async () => {
    await seedPackages(world, 250);
    world.server.script = [jsonReply(422, { success: false })];
    expect(await world.decide()).toMatchObject({ kind: 'failed', reason: 'limit' });
  });
});

describe('answers that are not data', () => {
  it('an office-staff 403 is "unavailable", not an error, and changes nothing', async () => {
    await seedPackages(world, 10);
    world.server.script = [jsonReply(403, { success: false, error: { code: 'FORBIDDEN' } })];
    const before = await world.hash();
    expect(await world.decide()).toEqual({ kind: 'unavailable', reason: 'role' });
    expect(await world.hash()).toBe(before);
  });

  it('a superset answer is a protocol violation', async () => {
    await seedPackages(world, 10);
    world.server.script = [(ids) => visibleReply([...ids, 'p999'])];
    expect(await world.decide()).toEqual({ kind: 'invalid', reason: 'bad_response' });
  });

  it.each([
    ['{}', jsonReply(200, {})],
    ['an html page', { ...jsonReply(200, {}), headers: new Headers({ 'content-type': 'text/html' }), json: undefined }],
    ['a duplicate id', visibleReply(['p001', 'p001'])],
  ])('%s is invalid, never "everything is missing"', async (_name, reply) => {
    await seedPackages(world, 10);
    world.server.script = [reply];
    const result = await world.decide();
    expect(result.kind).toBe('invalid');
  });

  it('control: an empty list in the exact shape is a real answer, and with everything missing it is the guarded case', async () => {
    await seedPackages(world, 10);
    world.server.script = [visibleReply([])];
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(true);
    expect(result.purge).toEqual([]);
    expect(result.quarantine).toHaveLength(10);
  });

  it('a 401 that the session check confirms is "auth" and nothing else', async () => {
    await seedPackages(world, 10);
    world.server.script = [jsonReply(401, { success: false })];
    world.checkSession.mockResolvedValueOnce({ kind: 'relogin' });
    expect(await world.decide()).toEqual({ kind: 'auth' });
  });

  it('control: a 401 the token manager can repair is retried and then answered', async () => {
    await seedPackages(world, 10);
    world.server.script = [jsonReply(401, { success: false })];
    expect((await world.decide()).kind).toBe('plan');
  });

  it('a 426 halts, a 429 and a 503 fail the run, a network error fails the run', async () => {
    await seedPackages(world, 10);
    world.server.script = [jsonReply(426, { success: false })];
    expect(await world.decide()).toMatchObject({ kind: 'halt' });
    world.server.script = [jsonReply(429, { success: false })];
    expect(await world.decide()).toMatchObject({ kind: 'failed', reason: 'rate_limited' });
    world.server.script = [jsonReply(503, { success: false })];
    expect(await world.decide()).toMatchObject({ kind: 'failed', reason: 'server' });
    world.server.script = [new AuthError('server_unreachable')];
    expect(await world.decide()).toMatchObject({ kind: 'failed', reason: 'network' });
  });

  it('the identity request failing, being unauthorised or answering nonsense ends the run before any id is sent', async () => {
    await seedPackages(world, 10);
    world.state.sessionError = new AuthError('server_unreachable');
    expect(await world.decide()).toEqual({ kind: 'failed', reason: 'session', retryAfterMs: null });
    world.state.sessionError = null;
    world.state.sessionStatus = 500;
    expect(await world.decide()).toEqual({ kind: 'invalid', reason: 'session' });
    world.state.sessionStatus = 401;
    world.checkSession.mockResolvedValueOnce({ kind: 'relogin' });
    expect(await world.decide()).toEqual({ kind: 'auth' });
    world.state.sessionStatus = 200;
    world.state.token = null;
    expect(await world.decide()).toEqual({ kind: 'auth' });
    expect(world.visibleRequests).toHaveLength(0);
  });

  it('control: when the identity request answers, the ids are sent', async () => {
    await seedPackages(world, 10);
    await world.decide();
    expect(world.visibleRequests).toHaveLength(1);
  });
});

describe('the lock', () => {
  it('a locked device sends nothing', async () => {
    await seedPackages(world, 10);
    world.state.locked = true;
    expect(await world.decide()).toEqual({ kind: 'locked' });
    expect(world.allRequests).toHaveLength(0);
  });

  it('a lock check that throws counts as locked', async () => {
    await seedPackages(world, 10);
    world.state.lockedThrows = true;
    expect(await world.decide()).toEqual({ kind: 'locked' });
    expect(world.allRequests).toHaveLength(0);
  });

  it('a lock that arrives between two batches stops the run: one request, no plan', async () => {
    await seedPackages(world, 301);
    world.server.hook = () => {
      world.state.locked = true;
    };
    expect(await world.decide()).toEqual({ kind: 'locked' });
    expect(world.visibleRequests).toHaveLength(1);
  });

  it('a lock that arrives while the only request is in flight discards the answer', async () => {
    await seedPackages(world, 10);
    world.server.hook = () => {
      world.state.locked = true;
    };
    hide('p003');
    expect(await world.decide()).toEqual({ kind: 'locked' });
  });

  it('a lock that arrives while the local data is being read discards the plan', async () => {
    await seedPackages(world, 10);
    hide('p003');
    const result = await world.decide({
      db: watching('FROM media WHERE inspection_id', () => {
        world.state.locked = true;
      }),
    });
    expect(result).toEqual({ kind: 'locked' });
  });

  it('control: the same run without a lock gives a plan', async () => {
    await seedPackages(world, 10);
    hide('p003');
    expect((await world.decide()).kind).toBe('plan');
  });
});

describe('one lease for everything that talks to the server about local data', () => {
  it('a lease held by another flow means busy and no request', async () => {
    await seedPackages(world, 10);
    expect(await acquireLease(world.db, SYNC_LEASE, { clock: world.clock })).not.toBeNull();
    expect(await world.decide()).toEqual({ kind: 'busy' });
    expect(world.allRequests).toHaveLength(0);
  });

  it('control: an expired lease does not block', async () => {
    await seedPackages(world, 10);
    await acquireLease(world.db, SYNC_LEASE, { clock: world.clock, ttlMs: 1000 });
    world.clock.advance(5000);
    expect((await world.decide()).kind).toBe('plan');
  });

  it('gives the lease back when it is done, whatever the outcome', async () => {
    await seedPackages(world, 10);
    await world.decide();
    expect(await world.db.query('SELECT * FROM lease')).toEqual([]);
    world.server.script = [jsonReply(500, { success: false })];
    await world.decide();
    expect(await world.db.query('SELECT * FROM lease')).toEqual([]);
  });

  it('a lease taken over while the request is in flight means no plan', async () => {
    await seedPackages(world, 10);
    world.server.hook = async () => {
      await world.db.run("UPDATE lease SET holder = 'someone-else'");
    };
    hide('p003');
    expect(await world.decide()).toEqual({ kind: 'lease_lost' });
  });
});

describe('the time budget', () => {
  it('a run that has used its time before the next batch is a failure, not a plan', async () => {
    await seedPackages(world, 301);
    world.server.hook = () => {
      world.clock.advance(120_000);
    };
    expect(await world.decide({ limits: { maxRunMs: 60_000 } })).toMatchObject({ kind: 'failed', reason: 'time_budget' });
  });

  it('a run that uses its time while the local data is being read is a failure, not a plan', async () => {
    await seedPackages(world, 10);
    hide('p001', 'p002', 'p003');
    const result = await world.decide({
      limits: { maxRunMs: 60_000 },
      db: watching('FROM media WHERE inspection_id', () => {
        world.clock.advance(120_000);
      }),
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'time_budget' });
  });

  it('control: the same run with time to spare finishes', async () => {
    await seedPackages(world, 301);
    world.server.hook = () => {
      world.clock.advance(1000);
    };
    expect((await world.decide({ limits: { maxRunMs: 60_000 } })).kind).toBe('plan');
  });

  it('no wall-clock age ever makes an inspection purgeable: a very old package with unsent data is still quarantined', async () => {
    await seedPackages(world, 10);
    await world.db.run('UPDATE work_package SET refreshed_at = 1');
    world.clock.advance(400 * 86_400_000);
    await world.outbox('p003', 'pending');
    hide('p003');
    expect(plan(await world.decide()).quarantine).toEqual(['p003']);
  });
});

describe('the decision never touches inspection data', () => {
  const scenarios: [string, () => Promise<void>, ReconcileResult['kind']][] = [
    [
      'a plan with purge and quarantine',
      async () => {
        await seedPackages(world, 12);
        await world.outbox('p002', 'pending');
        await world.ydoc('p004');
        await world.media('p005', 'uploaded');
        await world.pkg('q001', { quarantine: 'reconcile_missing' });
        hide('p001', 'p002', 'p003', 'p004', 'p005');
      },
      'plan',
    ],
    [
      'a plan converted by the mass guard',
      async () => {
        await seedPackages(world, 4);
        hide('p001', 'p002', 'p003', 'p004');
      },
      'plan',
    ],
    [
      'a plan with an un-quarantine',
      async () => {
        await seedPackages(world, 12);
        await world.pkg('q001', { quarantine: 'reconcile_missing' });
        hide('p003');
      },
      'plan',
    ],
    [
      'busy',
      async () => {
        await seedPackages(world, 4);
        await acquireLease(world.db, SYNC_LEASE, { clock: world.clock });
      },
      'busy',
    ],
    [
      'locked',
      async () => {
        await seedPackages(world, 4);
        world.state.locked = true;
      },
      'locked',
    ],
    [
      'no_account',
      async () => {
        await seedPackages(world, 4);
        world.state.account = null;
      },
      'no_account',
    ],
    [
      'account_mismatch',
      async () => {
        await seedPackages(world, 4);
        world.state.sessionIdentity = BOB;
      },
      'account_mismatch',
    ],
    [
      'unavailable',
      async () => {
        await seedPackages(world, 4);
        world.server.script = [jsonReply(403, {})];
      },
      'unavailable',
    ],
    [
      'auth',
      async () => {
        await seedPackages(world, 4);
        world.state.token = null;
      },
      'auth',
    ],
    [
      'halt',
      async () => {
        await seedPackages(world, 4);
        world.server.script = [jsonReply(426, {})];
      },
      'halt',
    ],
    [
      'failed',
      async () => {
        await seedPackages(world, 4);
        world.server.script = [jsonReply(500, {})];
      },
      'failed',
    ],
    [
      'invalid',
      async () => {
        await seedPackages(world, 4);
        world.server.script = [jsonReply(200, {})];
      },
      'invalid',
    ],
    [
      'refused',
      async () => {
        await seedPackages(world, 4);
        await world.outbox(null, 'pending');
      },
      'refused',
    ],
  ];

  async function count(table: string): Promise<number> {
    const rows = await world.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(rows[0]?.n ?? 0);
  }

  it.each(scenarios)('%s leaves every table byte-identical, and every table had data to lose', async (name, setup, kind) => {
    await setup();
    await seedEveryTable(world);
    for (const table of DATA_TABLES) expect(await count(table), `${table} is empty before the run`).toBeGreaterThan(0);
    expect(await count('ydoc_sync')).toBeGreaterThanOrEqual(2);
    const before = await world.hash();
    const leaseBefore = JSON.stringify(await world.db.query('SELECT * FROM lease'));
    const result = await world.decide();
    expect(result.kind).toBe(kind);
    expect(await world.hash()).toBe(before);
    const leaseAfter = JSON.stringify(await world.db.query('SELECT * FROM lease'));
    expect(leaseAfter, name).toBe(kind === 'busy' ? leaseBefore : '[]');
  });

  it.each([
    ['work_package', "UPDATE work_package SET pinned = 1 WHERE inspection_id = 'p002'"],
    ['outbox', "UPDATE outbox SET attempts = attempts + 1 WHERE inspection_id = 'p004'"],
    ['media', "UPDATE media SET attempts = attempts + 1 WHERE inspection_id = 'p002'"],
    ['ydoc_updates', "DELETE FROM ydoc_updates WHERE doc_name = 'results-p001'"],
    ['ydoc_sync (state vector row)', "UPDATE ydoc_sync SET updated_at = 99 WHERE doc_name = 'results-p001'"],
    ['ydoc_sync (delete set row)', "DELETE FROM ydoc_sync WHERE doc_name = 'ds:results-p001'"],
    ['resource_cache (a candidate)', "UPDATE resource_cache SET fetched_at = 99 WHERE key = 'k-candidate'"],
    ['resource_cache (not a candidate)', "DELETE FROM resource_cache WHERE key = 'k-global'"],
    ['device_state', "UPDATE device_state SET value = 'changed' WHERE key = 'seed-a'"],
  ])('the instrument sees a change: the hash moves when %s is written', async (_table, statement) => {
    await seedPackages(world, 4);
    await seedEveryTable(world);
    const before = await world.hash();
    await world.db.run(statement);
    expect(await world.hash()).not.toBe(before);
  });

  it('control: the hash does not move on its own', async () => {
    await seedPackages(world, 4);
    await seedEveryTable(world);
    expect(await world.hash()).toBe(await world.hash());
  });
});

describe('a storage failure', () => {
  it('is a typed failure with a fixed code, the lease is given back, and nothing is changed', async () => {
    await seedPackages(world, 10);
    const before = await world.hash();
    const result = await world.decide({
      db: watching('FROM work_package', () => {
        throw new Error('disk exploded with a secret');
      }),
    });
    expect(result).toEqual({ kind: 'failed', reason: 'storage', retryAfterMs: null });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(await world.db.query('SELECT * FROM lease')).toEqual([]);
    expect(await world.hash()).toBe(before);
  });

  it('control: the same database without the fault gives a plan', async () => {
    await seedPackages(world, 10);
    expect((await world.decide()).kind).toBe('plan');
  });
});

describe('what a result may contain', () => {
  it('no token, no server wording', async () => {
    await seedPackages(world, 10);
    world.server.script = [jsonReply(500, { success: false, error: { message: 'secret server wording' } })];
    const text = JSON.stringify(await world.decide());
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('secret server wording');
    expect(ALICE.userId.length).toBeGreaterThan(0);
  });
});

describe('what a plan carries for the executor', () => {
  it('names the account it was decided for and the injected time it was decided at', async () => {
    await seedPackages(world, 10);
    hide('p003');
    world.server.hook = () => {
      world.clock.advance(1234);
    };
    const started = world.clock.now();
    const result = plan(await world.decide());
    expect(result.account).toEqual(ALICE);
    expect(result.decidedAt).toBe(started + 1234);
    expect(result.candidateCount).toBe(10);
    expect(result.allMissing).toBe(false);
  });

  it('carries a fingerprint for every id with an action and for no other id', async () => {
    await seedPackages(world, 12);
    await world.outbox('p002', 'pending');
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    hide('p001', 'p002');
    const result = plan(await world.decide());
    expect(result.purge).toEqual(['p001']);
    expect(result.quarantine).toEqual(['p002']);
    expect(result.unquarantine).toEqual(['q001']);
    expect(Object.keys(result.fingerprints).sort()).toEqual(['p001', 'p002', 'q001']);
    for (const fingerprint of Object.values(result.fingerprints)) expect(fingerprint.length).toBeGreaterThan(2);
  });

  it('a fingerprint moves when the local facts of that id move', async () => {
    await seedPackages(world, 10);
    hide('p003');
    const first = plan(await world.decide());
    await world.db.run('UPDATE work_package SET pinned = 1 WHERE inspection_id = ?', ['p003']);
    await world.outbox('p003', 'pending');
    const second = plan(await world.decide());
    expect(first.fingerprints.p003).toBeDefined();
    expect(second.quarantine).toEqual(['p003']);
    expect(second.fingerprints.p003).not.toBe(first.fingerprints.p003);
  });

  it('gives a fixed reason code to every purge and quarantine, and none to the rest', async () => {
    await seedPackages(world, 12);
    await world.outbox('p002', 'pending');
    await world.media('p004', 'uploaded');
    hide('p001', 'p002', 'p004');
    const result = plan(await world.decide());
    expect(result.reasons).toEqual({ p001: [REASON_NOT_VISIBLE], p002: ['outbox_pending'], p004: ['media_uploaded_unresolved'] });
  });

  it('an empty plan carries empty maps', async () => {
    const result = plan(await world.decide());
    expect(result.fingerprints).toEqual({});
    expect(result.reasons).toEqual({});
    expect(result.candidateCount).toBe(0);
    expect(result.allMissing).toBe(false);
    expect(result.account).toEqual(ALICE);
  });

  it('no result other than a plan carries an inspection id', async () => {
    const outcomes: [string, () => Promise<ReconcileResult>][] = [
      ['locked', () => ((world.state.locked = true), world.decide())],
      ['no_account', () => ((world.state.account = null), world.decide())],
      ['account_mismatch', () => ((world.state.sessionIdentity = BOB), world.decide())],
      ['unavailable', () => ((world.server.script = [jsonReply(403, {})]), world.decide())],
      ['auth', () => ((world.state.token = null), world.decide())],
      ['halt', () => ((world.server.script = [jsonReply(426, {})]), world.decide())],
      ['failed', () => ((world.server.script = [jsonReply(500, {})]), world.decide())],
      ['invalid', () => ((world.server.script = [jsonReply(200, {})]), world.decide())],
      ['refused', async () => (await world.outbox(null, 'pending'), world.decide())],
      ['busy', async () => (await acquireLease(world.db, SYNC_LEASE, { clock: world.clock }), world.decide())],
      [
        'lease_lost',
        () => {
          world.server.hook = async () => {
            await world.db.run("UPDATE lease SET holder = 'someone-else'");
          };
          return world.decide();
        },
      ],
    ];
    for (const [name, run] of outcomes) {
      world = await createReconcileWorld();
      await seedPackages(world, 10);
      hide('p003');
      const result = await run();
      expect(result.kind, name).toBe(name);
      expect(JSON.stringify(result), name).not.toMatch(/p0\d\d/);
      expect(Object.keys(result).filter((key) => ['purge', 'quarantine', 'unquarantine', 'keep', 'deferred', 'fingerprints', 'reasons'].includes(key)), name).toEqual([]);
    }
  });
});

describe('planIsStale', () => {
  const decided = { decidedAt: 1_000_000 };

  it('is fresh up to and including the maximum age, and stale one millisecond later', () => {
    expect(planIsStale(decided, 1_000_000)).toBe(false);
    expect(planIsStale(decided, 1_000_000 + 5 * 60_000)).toBe(false);
    expect(planIsStale(decided, 1_000_000 + 5 * 60_000 + 1)).toBe(true);
  });

  it('takes the limit from the caller', () => {
    expect(planIsStale(decided, 1_000_000 + 1000, 1000)).toBe(false);
    expect(planIsStale(decided, 1_000_000 + 1001, 1000)).toBe(true);
  });

  it('a plan from the future (the clock went backwards) and a time that is not a number are stale', () => {
    expect(planIsStale(decided, 999_999)).toBe(true);
    expect(planIsStale(decided, Number.NaN)).toBe(true);
    expect(planIsStale({ decidedAt: Number.NaN }, 1_000_000)).toBe(true);
  });

  it('works on a real plan against the injected clock', async () => {
    await seedPackages(world, 3);
    const result: ReconcilePlan = plan(await world.decide());
    expect(planIsStale(result, world.clock.now())).toBe(false);
    world.clock.advance(5 * 60_000 + 1);
    expect(planIsStale(result, world.clock.now())).toBe(true);
  });
});

describe('a single inspection, or an answer that lists none of them', () => {
  it('is never purged: it is quarantined with the reason the interface can act on', async () => {
    await seedPackages(world, 1);
    hide('p001');
    const result = plan(await world.decide());
    expect(result.purge).toEqual([]);
    expect(result.quarantine).toEqual(['p001']);
    expect(result.reasons).toEqual({ p001: [REASON_MASS_SUSPICIOUS] });
    expect(result.allMissing).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.massSuspicious).toBe(true);
  });

  it('an empty answer for ten inspections says allMissing with the count, and quarantines all of them', async () => {
    await seedPackages(world, 10);
    world.server.script = [visibleReply([])];
    const result = plan(await world.decide());
    expect(result.allMissing).toBe(true);
    expect(result.candidateCount).toBe(10);
    expect(Object.keys(result.reasons)).toHaveLength(10);
    for (const reasons of Object.values(result.reasons)) expect(reasons).toEqual([REASON_MASS_SUSPICIOUS]);
  });

  it('control: an ordinary deletion is not allMissing and its reason is not mass_suspicious', async () => {
    await seedPackages(world, 10);
    hide('p003');
    const result = plan(await world.decide());
    expect(result.allMissing).toBe(false);
    expect(result.reasons.p003).toEqual([REASON_NOT_VISIBLE]);
  });

  it('an inspection that also holds unsent work is quarantined for that, not marked as a guard conversion', async () => {
    await seedPackages(world, 1);
    await world.outbox('p001', 'pending');
    hide('p001');
    const result = plan(await world.decide());
    expect(result.reasons).toEqual({ p001: ['outbox_pending'] });
    expect(result.proof.convertedToQuarantine).toBe(0);
  });

  it('when nothing but quarantined inspections is left and all of them are missing, nothing is suspicious and they stay', async () => {
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    await world.pkg('q002', { quarantine: 'reconcile_missing' });
    hide('q001', 'q002');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(false);
    expect(result.allMissing).toBe(true);
    expect(sorted(result.keep)).toEqual(['q001', 'q002']);
    expect(result.quarantine).toEqual([]);
    expect(result.purge).toEqual([]);
  });
});

describe('the mass guard counts only inspections that are not yet quarantined', () => {
  async function withQuarantinedMissing(quarantined: number, fresh: number): Promise<string[]> {
    const ids = await seedPackages(world, fresh);
    for (let i = 1; i <= quarantined; i += 1) {
      const id = `q${String(i).padStart(3, '0')}`;
      await world.pkg(id, { quarantine: 'reconcile_missing' });
      hide(id);
    }
    return ids;
  }

  it('8 quarantined-missing and 2 of 10 new ones missing is an ordinary reconcile: the two are purged', async () => {
    await withQuarantinedMissing(8, 10);
    hide('p001', 'p002');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(false);
    expect(sorted(result.purge)).toEqual(['p001', 'p002']);
    expect(result.keep).toHaveLength(8 + 8);
    expect(result.allMissing).toBe(false);
  });

  it('control: 6 of 10 new ones missing is still suspicious with the same 8 quarantined-missing', async () => {
    await withQuarantinedMissing(8, 10);
    hide('p001', 'p002', 'p003', 'p004', 'p005', 'p006');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(true);
    expect(result.purge).toEqual([]);
    expect(sorted(result.quarantine)).toEqual(['p001', 'p002', 'p003', 'p004', 'p005', 'p006']);
    expect(result.keep).toHaveLength(8 + 4);
  });

  it('every new one missing is suspicious even when a quarantined one is listed again by the server', async () => {
    await seedPackages(world, 3);
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    hide('p001', 'p002', 'p003');
    const result = plan(await world.decide());
    expect(result.massSuspicious).toBe(true);
    expect(result.unquarantine).toEqual([]);
    expect(result.purge).toEqual([]);
  });
});

describe('what the run re-reads after the answer', () => {
  it('an account that disappears while the request is in flight is "no_account", not a storage failure', async () => {
    await seedPackages(world, 10);
    world.server.hook = () => {
      world.state.account = null;
    };
    hide('p003');
    expect(await world.decide()).toEqual({ kind: 'no_account' });
  });

  it('a queued write without an inspection that only the unsent read sees still refuses the run', async () => {
    await seedPackages(world, 10);
    hide('p003');
    let globalChecks = 0;
    const wrap = (inner: typeof world.db): typeof world.db => ({
      ...inner,
      query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        const rows = await inner.query<T>(sql, params);
        if (!sql.startsWith('SELECT inspection_id, op, COUNT(*) AS n FROM outbox GROUP BY')) return rows;
        globalChecks += 1;
        return globalChecks === 3 ? [...rows, { inspection_id: null, op: 'inspection.update', n: 1 } as T] : rows;
      },
      transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
    });
    const result = await world.decide({ db: wrap(world.db) });
    expect(globalChecks).toBe(3);
    expect(result).toEqual({ kind: 'refused', reason: 'null_inspection_id' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['the string "false"', 'false'],
    ['0', 0],
  ])('a lock check that answers %s instead of a boolean counts as locked', async (_name, answer) => {
    await seedPackages(world, 10);
    const result = await world.decide({ isLocked: () => answer as never });
    expect(result).toEqual({ kind: 'locked' });
    expect(world.allRequests).toHaveLength(0);
  });

  it('control: a lock check that answers exactly false proceeds', async () => {
    await seedPackages(world, 10);
    expect((await world.decide({ isLocked: () => false })).kind).toBe('plan');
  });
});

describe('the fingerprint covers the sync proof rows', () => {
  async function missingWithHook(change: () => Promise<void>): Promise<Extract<ReconcileResult, { kind: 'plan' }>> {
    await seedPackages(world, 10);
    world.server.hook = change;
    hide('p003');
    return plan(await world.decide());
  }

  it('control: without a change the missing inspection is purged', async () => {
    const result = await missingWithHook(() => Promise.resolve());
    expect(result.purge).toEqual(['p003']);
  });

  it('a state vector that appears while the request is in flight defers the inspection', async () => {
    const result = await missingWithHook(() => recordServerStateVector(world.db, 'results-p003', Y.encodeStateVector(new Y.Doc()), 7));
    expect(result.deferred).toEqual(['p003']);
    expect(result.purge).toEqual([]);
  });

  it('a state vector that is rewritten while the request is in flight defers the inspection', async () => {
    await seedPackages(world, 10);
    await recordServerStateVector(world.db, 'results-p003', Y.encodeStateVector(new Y.Doc()), 1);
    world.server.hook = () => recordServerStateVector(world.db, 'results-p003', Y.encodeStateVector(new Y.Doc()), 2);
    hide('p003');
    const result = plan(await world.decide());
    expect(result.deferred).toEqual(['p003']);
    expect(result.purge).toEqual([]);
  });

  it('a delete set that appears while the request is in flight defers the inspection', async () => {
    const result = await missingWithHook(() => recordServerDeleteSet(world.db, 'results-p003', Y.encodeStateAsUpdate(new Y.Doc()), 7));
    expect(result.deferred).toEqual(['p003']);
    expect(result.purge).toEqual([]);
  });

  it('a proof row of another inspection does not defer this one', async () => {
    const result = await missingWithHook(() => recordServerDeleteSet(world.db, 'results-p005', Y.encodeStateAsUpdate(new Y.Doc()), 7));
    expect(result.deferred).toEqual([]);
    expect(result.purge).toEqual(['p003']);
  });
});

describe('an un-quarantine is decided on the same facts it was fingerprinted on', () => {
  it('control: a quarantined inspection listed again with nothing changing is un-quarantined', async () => {
    await seedPackages(world, 5);
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    expect(plan(await world.decide()).unquarantine).toEqual(['q001']);
  });

  it('is deferred when something about it changed while the request was in flight', async () => {
    await seedPackages(world, 5);
    await world.pkg('q001', { quarantine: 'reconcile_missing' });
    world.server.hook = () => world.outbox('q001', 'pending');
    const result = plan(await world.decide());
    expect(result.deferred).toEqual(['q001']);
    expect(result.unquarantine).toEqual([]);
    expect(result.fingerprints.q001).toBeUndefined();
  });
});
