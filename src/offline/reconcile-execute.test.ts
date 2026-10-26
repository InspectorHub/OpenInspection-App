import { beforeEach, describe, expect, it } from 'vitest';
import { CollabBlockedError } from '../collab/connector';
import { createManualClock } from '../platform/clock';
import { DEFAULT_PLAN_MAX_AGE_MS, fingerprintOf, REASON_MASS_SUSPICIOUS, REASON_NOT_VISIBLE, type ReconcilePlan } from './reconcile-decision';
import { executeReconcilePlan as executeIssued, type ExecuteDeps } from './reconcile-execute';
import { accountKey, enqueue } from './outbox';
import { issuePlanForTest, purgeAuthorityForTest } from './test-support/brands';
import { purgeInspection, resumePurges } from './purge';
import { countOrphanedOutbox } from './waiting';
import { createPurgeWorld, type InspectionTable, type PurgeWorld } from './test-support/purge-world';
import { ALICE, BOB, DATA_TABLES, seedEveryTable, seedPackages } from './test-support/reconcile-world';

let world: PurgeWorld;

/** Most tests here edit a plan by hand to reach one rule, so the plan is registered as issued first; the issuer check has its own tests. */
const executeReconcilePlan = (deps: ExecuteDeps, plan: ReconcilePlan): ReturnType<typeof executeIssued> => executeIssued(deps, issuePlanForTest(plan));

beforeEach(async () => {
  world = await createPurgeWorld();
});

const ZERO: Record<InspectionTable | 'files', number> = { work_package: 0, outbox: 0, media: 0, ydoc_updates: 0, ydoc_sync: 0, resource_cache: 0, files: 0 };

async function planOf(...hidden: string[]): Promise<ReconcilePlan> {
  world.server.hidden = new Set(hidden);
  const result = await world.decide();
  if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
  return result;
}

/** Six inspections: p2 is purgeable, the others hold data in every table (and p5 is quarantined). */
async function seedSix(): Promise<void> {
  await world.seedFull('p1');
  await world.seedPurgeable('p2');
  await world.seedFull('p3');
  await world.seedFull('p4');
  await world.seedFull('p5');
  await world.seedFull('p6');
}

async function snapshots(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = await world.data(id);
  return out;
}

async function allCounts(ids: string[]): Promise<Record<string, Record<InspectionTable | 'files', number>>> {
  const out: Record<string, Record<InspectionTable | 'files', number>> = {};
  for (const id of ids) out[id] = await world.counts(id);
  return out;
}

const flags = async (id: string): Promise<{ quarantine_source: string | null; purging: number } | undefined> => (await world.db.query<{ quarantine_source: string | null; purging: number }>('SELECT quarantine_source, purging FROM work_package WHERE inspection_id = ?', [id]))[0];

describe('carrying out a decision', () => {
  it('purges the one missing inspection with nothing unsent, and leaves every table of the others as it was', async () => {
    await seedSix();
    const others = ['p1', 'p3', 'p4', 'p5', 'p6'];
    const before = await snapshots(others);
    const beforeCounts = await allCounts(others);
    const plan = await planOf('p2');
    expect(plan.purge).toEqual(['p2']);
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 1, quarantined: 0, unquarantined: 0, deferred: 0, skippedChanged: 0, failed: 0 } });
    expect(await world.counts('p2')).toEqual(ZERO);
    expect(await snapshots(others)).toEqual(before);
    expect(await allCounts(others)).toEqual(beforeCounts);
    expect(world.purgingSignals).toEqual(['p2']);
  });

  it('control: when the server lists all of them the same run changes nothing at all', async () => {
    await seedSix();
    const hash = await world.hash();
    const plan = await planOf();
    expect(plan.purge).toEqual([]);
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, quarantined: 0 } });
    expect(await world.hash()).toBe(hash);
  });

  it('a missing inspection WITH unsent data is quarantined, nothing is deleted, and every module is kept away from it', async () => {
    await seedSix();
    await world.seedFull('p7');
    const before = await world.counts('p7');
    const others = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const kept = await snapshots(others);
    const plan = await planOf('p7');
    expect(plan.quarantine).toEqual(['p7']);
    expect(plan.purge).toEqual([]);
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, quarantined: 1, failed: 0 } });
    expect(await world.counts('p7')).toEqual(before);
    expect(await flags('p7')).toEqual({ quarantine_source: 'reconcile_missing', purging: 0 });
    expect(await snapshots(others)).toEqual(kept);
    expect(world.quarantineSignals).toEqual(['p7']);
    // The data layer keeps the editor's connection, the queue, the refresh and the photo store away.
    expect(await world.purgeDeps().isBlocked('p7')).toBe(true);
    await expect(world.connect('p7').persistenceSynced).rejects.toBeInstanceOf(CollabBlockedError);
    const refused = await enqueue({ db: world.db, clock: world.clock }, 'inspection.update', { inspectionId: 'p7', changes: { sqft: 1 } }, { account: ALICE }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'blocked' });
    // The held queue items are counted on their own line.
    expect(await countOrphanedOutbox(world.db)).toBe(1);
  });

  it('control: the same inspection, listed by the server, is not touched', async () => {
    await seedSix();
    await world.seedFull('p7');
    const hash = await world.hash();
    const result = await executeReconcilePlan(world.executeDeps(), await planOf());
    expect(result).toMatchObject({ kind: 'done', summary: { quarantined: 0 } });
    expect(await world.hash()).toBe(hash);
  });

  it('an answer that would remove every inspection quarantines them all and deletes nothing', async () => {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    await world.seedPurgeable('p3');
    const before = await allCounts(['p1', 'p2', 'p3']);
    const plan = await planOf('p1', 'p2', 'p3');
    expect(plan).toMatchObject({ massSuspicious: true, allMissing: true, purge: [] });
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, quarantined: 3 } });
    expect(await allCounts(['p1', 'p2', 'p3'])).toEqual(before);
    for (const id of ['p1', 'p2', 'p3']) expect((await flags(id))?.quarantine_source).toBe('reconcile_missing');
  });

  it('control: the same three inspections with only one missing purge exactly that one', async () => {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    await world.seedPurgeable('p3');
    const result = await executeReconcilePlan(world.executeDeps(), await planOf('p2'));
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 1, quarantined: 0 } });
    expect((await world.counts('p2')).work_package).toBe(0);
    expect((await world.counts('p1')).work_package).toBe(1);
    expect((await world.counts('p3')).work_package).toBe(1);
  });

  it('a pinned inspection gets no exemption: purged when clean, quarantined when it holds unsent work', async () => {
    await seedSix();
    await world.db.run('UPDATE work_package SET pinned = 1 WHERE inspection_id IN (?, ?)', ['p2', 'p3']);
    const plan = await planOf('p2', 'p3');
    expect(plan.purge).toEqual(['p2']);
    expect(plan.quarantine).toEqual(['p3']);
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 1, quarantined: 1 } });
    expect((await world.counts('p2')).work_package).toBe(0);
    expect((await flags('p3'))?.quarantine_source).toBe('reconcile_missing');
  });

  it('does all three kinds at once: purge, quarantine and un-quarantine, restoring the held queue', async () => {
    await seedSix();
    await world.seedFull('p7');
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p4'");
    await world.db.run("UPDATE outbox SET state = 'orphaned', last_error = 'target_gone' WHERE inspection_id = 'p4' AND state = 'pending'");
    const plan = await planOf('p2', 'p7');
    expect(plan).toMatchObject({ purge: ['p2'], quarantine: ['p7'], unquarantine: ['p4'] });
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 1, quarantined: 1, unquarantined: 1, failed: 0 } });
    expect((await flags('p4'))?.quarantine_source).toBeNull();
    expect(await world.db.query("SELECT state FROM outbox WHERE inspection_id = 'p4' ORDER BY seq")).toEqual([{ state: 'pending' }, { state: 'failed' }]);
    expect(world.unquarantineSignals).toEqual(['p4']);
  });
});

describe('a plan is carried out only while everything it rested on still holds', () => {
  it('a plan older than the limit is not carried out; a fresh one is (control)', async () => {
    await seedSix();
    const plan = await planOf('p2');
    world.clock.advance(DEFAULT_PLAN_MAX_AGE_MS + 1);
    const hash = await world.hash();
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'stopped', reason: 'stale_plan' });
    expect(await world.hash()).toBe(hash);
    world.clock.set(plan.decidedAt + 1000);
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { purged: 1 } });
  });

  it('a plan for one account is not carried out for another, or for nobody', async () => {
    await seedSix();
    const plan = await planOf('p2');
    const hash = await world.hash();
    world.state.account = BOB;
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'stopped', reason: 'account_mismatch' });
    world.state.account = null;
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'stopped', reason: 'no_account' });
    expect(await executeReconcilePlan(world.executeDeps({ account: () => Promise.reject(new Error('unreadable')) }), plan)).toMatchObject({ kind: 'stopped', reason: 'no_account' });
    expect(await world.hash()).toBe(hash);
    world.state.account = ALICE;
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { purged: 1 } });
  });

  it('nothing is done while the device is locked, expired, revoked or its lock cannot be read', async () => {
    await seedSix();
    const plan = await planOf('p2');
    const hash = await world.hash();
    world.state.locked = true;
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'stopped', reason: 'locked' });
    world.state.locked = false;
    world.state.lockedThrows = true;
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'stopped', reason: 'locked' });
    world.state.lockedThrows = false;
    expect(await world.hash()).toBe(hash);
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { purged: 1 } });
  });

  it('nothing is done while another flow holds the shared lease', async () => {
    await seedSix();
    const plan = await planOf('p2');
    await world.db.run("INSERT INTO lease (name, holder, expires_at) VALUES ('sync', 'replayer', ?)", [world.clock.now() + 30_000]);
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'stopped', reason: 'busy' });
    expect((await world.counts('p2')).work_package).toBe(1);
  });

  it('two runs of the same plan at once: one does the work, the other finds the lease taken, and the lease is free afterwards', async () => {
    await seedSix();
    const plan = await planOf('p2');
    const [a, b] = await Promise.all([executeReconcilePlan(world.executeDeps(), plan), executeReconcilePlan(world.executeDeps(), plan)]);
    expect([a.kind, b.kind].sort()).toEqual(['done', 'stopped']);
    expect(await world.db.query('SELECT 1 FROM lease')).toEqual([]);
    expect((await world.counts('p2')).work_package).toBe(0);
  });

  it('a lock that arrives in the middle stops before the next inspection', async () => {
    await seedSix();
    await world.seedFull('p7');
    await world.seedFull('p8');
    const plan = await planOf('p7', 'p8');
    expect(plan.quarantine).toEqual(['p7', 'p8']);
    const result = await executeReconcilePlan(
      world.executeDeps({
        onQuarantined: (id) => {
          world.quarantineSignals.push(id);
          world.state.locked = true;
        },
      }),
      plan,
    );
    expect(result).toMatchObject({ kind: 'stopped', reason: 'locked', summary: { quarantined: 1 } });
    expect((await flags('p7'))?.quarantine_source).toBe('reconcile_missing');
    expect((await flags('p8'))?.quarantine_source).toBeNull();
  });

  it('does the quarantines before the purges, so a lock that arrives during the first purge has already held the unsent work', async () => {
    await seedSix();
    await world.seedFull('p7');
    const plan = await planOf('p2', 'p7');
    expect(plan).toMatchObject({ purge: ['p2'], quarantine: ['p7'] });
    const result = await executeReconcilePlan(
      world.executeDeps({
        onPurging: () => {
          world.state.locked = true;
        },
      }),
      plan,
    );
    expect(result).toMatchObject({ kind: 'stopped', reason: 'locked' });
    expect((await flags('p7'))?.quarantine_source).toBe('reconcile_missing');
    expect((await flags('p2'))?.purging).toBe(1);
  });

  it.each([
    ['a queued write', () => world.outbox('p2', 'pending')],
    ['a photo', () => world.mediaFile('p2', 'late', 'pending')],
    ['an edit', async () => void (await world.ydoc('p2'))],
  ])('%s that arrived since the plan: the inspection is skipped, not purged and not quarantined', async (_name, change) => {
    await seedSix();
    const plan = await planOf('p2');
    await change();
    const before = await world.counts('p2');
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, quarantined: 0, skippedChanged: 1, failed: 0 } });
    expect(await world.counts('p2')).toEqual(before);
    expect(await flags('p2')).toEqual({ quarantine_source: null, purging: 0 });
  });

  it('a changed inspection is skipped while the unchanged ones of the same plan are carried out', async () => {
    await seedSix();
    await world.seedPurgeable('p8');
    const plan = await planOf('p2', 'p8');
    expect(plan.purge).toEqual(['p2', 'p8']);
    await world.outbox('p2', 'pending');
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 1, skippedChanged: 1 } });
    expect((await world.counts('p8')).work_package).toBe(0);
    expect((await world.counts('p2')).work_package).toBe(1);
  });

  it('an inspection the plan has no fingerprint for is skipped', async () => {
    await seedSix();
    const plan = await planOf('p2');
    const result = await executeReconcilePlan(world.executeDeps(), { ...plan, fingerprints: {} });
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, skippedChanged: 1 } });
    expect((await world.counts('p2')).work_package).toBe(1);
  });

  it('a changed quarantine candidate and a changed un-quarantine candidate are skipped the same way', async () => {
    await seedSix();
    await world.seedFull('p7');
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p4'");
    const plan = await planOf('p7');
    expect(plan).toMatchObject({ quarantine: ['p7'], unquarantine: ['p4'] });
    await world.outbox('p7', 'pending');
    await world.outbox('p4', 'pending');
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { quarantined: 0, unquarantined: 0, skippedChanged: 2 } });
    expect((await flags('p4'))?.quarantine_source).toBe('reconcile_missing');
  });

  it('a purge that finds unsent data inside the tombstone transaction becomes a quarantine and deletes nothing', async () => {
    await seedSix();
    await world.seedFull('p7');
    const base = await planOf();
    const plan: ReconcilePlan = { ...base, purge: ['p7'], fingerprints: { p7: await fingerprintOf(world.db, 'p7') }, reasons: { p7: [REASON_NOT_VISIBLE] } };
    const before = await world.counts('p7');
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, quarantined: 1, failed: 0 } });
    expect(await world.counts('p7')).toEqual(before);
    expect((await flags('p7'))?.quarantine_source).toBe('reconcile_missing');
  });

  it('control: the same hand-made entry for a clean inspection is purged', async () => {
    await seedSix();
    const base = await planOf();
    const plan: ReconcilePlan = { ...base, purge: ['p2'], fingerprints: { p2: await fingerprintOf(world.db, 'p2') }, reasons: { p2: [REASON_NOT_VISIBLE] } };
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { purged: 1 } });
  });
});

describe('a plan is never widened', () => {
  async function handmade(overrides: Partial<ReconcilePlan>, ids: string[] = ['p2']): Promise<ReconcilePlan> {
    const base = await planOf();
    const fingerprints: Record<string, string> = {};
    for (const id of ids) fingerprints[id] = await fingerprintOf(world.db, id);
    return { ...base, fingerprints, ...overrides };
  }

  it('purges named in a plan that says the answer was suspicious or listed nothing are not carried out', async () => {
    await seedSix();
    const hash = await world.hash();
    for (const flag of [{ massSuspicious: true }, { allMissing: true }]) {
      const plan = await handmade({ ...flag, purge: ['p2'], reasons: { p2: [REASON_NOT_VISIBLE] } });
      const result = await executeReconcilePlan(world.executeDeps(), plan);
      expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, failed: 1, failures: { incoherent_plan: 1 } } });
    }
    expect(await world.hash()).toBe(hash);
  });

  it('a mass of purges (more than five and more than half of the candidates) is not carried out whatever the flags say', async () => {
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']) await world.seedPurgeable(id);
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const base = await planOf();
    const fingerprints: Record<string, string> = {};
    const reasons: Record<string, string[]> = {};
    for (const id of ids) {
      fingerprints[id] = await fingerprintOf(world.db, id);
      reasons[id] = [REASON_NOT_VISIBLE];
    }
    const hash = await world.hash();
    const result = await executeReconcilePlan(world.executeDeps(), { ...base, purge: ids, fingerprints, reasons, massSuspicious: false, allMissing: false, candidateCount: 8 });
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, failures: { incoherent_plan: 6 } } });
    expect(await world.hash()).toBe(hash);
  });

  it('an un-quarantine named in a suspicious plan is not carried out', async () => {
    await seedSix();
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p4'");
    const plan = await handmade({ massSuspicious: true, unquarantine: ['p4'] }, ['p4']);
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { unquarantined: 0, failures: { incoherent_plan: 1 } } });
    expect((await flags('p4'))?.quarantine_source).toBe('reconcile_missing');
  });

  it('a purge whose reasons say anything but "not visible, nothing unsent" is not carried out', async () => {
    await seedSix();
    for (const reasons of [[REASON_MASS_SUSPICIOUS], ['outbox_pending'], [], [REASON_NOT_VISIBLE, 'media_not_uploaded']]) {
      const plan = await handmade({ purge: ['p2'], reasons: { p2: reasons } });
      const result = await executeReconcilePlan(world.executeDeps(), plan);
      expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, failures: { incoherent_plan: 1 } } });
    }
    expect((await world.counts('p2')).work_package).toBe(1);
    expect(await executeReconcilePlan(world.executeDeps(), await handmade({ purge: ['p2'], reasons: { p2: [REASON_NOT_VISIBLE] } }))).toMatchObject({ kind: 'done', summary: { purged: 1 } });
  });

  it('an id named in two lists is not acted on at all', async () => {
    await seedSix();
    const plan = await handmade({ purge: ['p2'], quarantine: ['p2'], reasons: { p2: [REASON_NOT_VISIBLE] } });
    const hash = await world.hash();
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, quarantined: 0, failures: { contradictory_plan: 1 } } });
    expect(await world.hash()).toBe(hash);
  });

  it('an id that is not an inspection id is not acted on', async () => {
    await seedSix();
    const plan = await handmade({ purge: ['../etc'], fingerprints: { '../etc': 'x' }, reasons: { '../etc': [REASON_NOT_VISIBLE] } });
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { purged: 0, failures: { invalid_id: 1 } } });
  });

  it('an id the device has no package for, or another account owns, is refused with nothing written', async () => {
    await seedSix();
    await world.db.run("UPDATE work_package SET user_id = 'bob' WHERE inspection_id = 'p2'");
    const plan = await handmade({ purge: ['p2', 'ghost'], reasons: { p2: [REASON_NOT_VISIBLE], ghost: [REASON_NOT_VISIBLE] } }, ['p2', 'ghost']);
    const hash = await world.hash();
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, failed: 2 } });
    expect(await world.hash()).toBe(hash);
  });
});

describe('a purge that cannot finish does not stop the others', () => {
  it('one inspection fails midway and keeps its tombstone; the others are purged; the next resume finishes it', async () => {
    await seedSix();
    await world.seedPurgeable('p8');
    await world.seedPurgeable('p9');
    const plan = await planOf('p2', 'p8', 'p9');
    expect(plan.purge).toEqual(['p2', 'p8', 'p9']);
    const real = world.connector;
    const result = await executeReconcilePlan(
      world.executeDeps({
        connector: {
          purge: (id) => (id === 'p8' ? Promise.reject(new Error('injected')) : real.purge(id)),
          closeFor: (id) => real.closeFor(id),
        },
      }),
      plan,
    );
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 2, failed: 1, failures: { storage_failed: 1 } } });
    expect((await world.counts('p2')).work_package).toBe(0);
    expect((await world.counts('p9')).work_package).toBe(0);
    expect((await flags('p8'))?.purging).toBe(1);
    const resumed = await resumePurges({ ...world.purgeDeps(), clock: world.clock, account: () => ALICE, isLocked: () => false });
    expect(resumed).toMatchObject({ resumed: 1, failed: 0 });
    expect(await world.counts('p8')).toEqual(ZERO);
  });

  it('an inspection open in the editor is deferred, left whole, and the others still go', async () => {
    await seedSix();
    await world.seedPurgeable('p8');
    const plan = await planOf('p2', 'p8');
    world.editorOpen.add('p2');
    const result = await executeReconcilePlan(world.executeDeps(), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 1, deferred: 1 } });
    expect(await flags('p2')).toEqual({ quarantine_source: null, purging: 0 });
    expect((await world.counts('p2')).ydoc_updates).toBeGreaterThan(0);
    expect((await world.counts('p8')).work_package).toBe(0);
  });

  it('a storage failure on one id is collected, never thrown', async () => {
    await seedSix();
    const plan = await planOf('p2');
    const real = world.db;
    const broken = {
      ...real,
      transaction: () => Promise.reject(new Error('storage gone')),
    } as typeof real;
    const result = await executeReconcilePlan(world.executeDeps({ db: broken, clock: createManualClock(plan.decidedAt) }), plan);
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 0, failed: 1, failures: { storage_failed: 1 } } });
    expect((await world.counts('p2')).work_package).toBe(1);
  });
});

describe('the summary is made of fixed codes only', () => {
  it('failure keys are codes, never text from a row, a path or an error', async () => {
    await seedSix();
    await world.seedPurgeable('p8');
    const plan = await planOf('p2', 'p8');
    const real = world.connector;
    const result = await executeReconcilePlan(
      world.executeDeps({ connector: { purge: () => Promise.reject(new Error('secret /path/to/file.jpg token=abc')), closeFor: (id) => real.closeFor(id) } }),
      plan,
    );
    expect(result.kind).toBe('done');
    const text = JSON.stringify(result);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/path');
    expect(Object.keys(result.summary.failures).every((key) => /^[a-z_]+$/.test(key))).toBe(true);
  });
});

/** Every row of every data table except the ones that belong to `id`, as one string. */
async function hashExcluding(id: string, ownFiles: readonly string[] = []): Promise<string> {
  const filters: Record<string, { sql: string; params: unknown[] }> = {
    work_package: { sql: 'inspection_id <> ?', params: [id] },
    outbox: { sql: 'inspection_id IS NOT ?', params: [id] },
    media: { sql: 'inspection_id <> ?', params: [id] },
    ydoc_updates: { sql: 'doc_name <> ?', params: [`results-${id}`] },
    ydoc_sync: { sql: 'doc_name NOT IN (?, ?)', params: [`results-${id}`, `ds:results-${id}`] },
    resource_cache: { sql: 'package_id IS NOT ?', params: [id] },
    device_state: { sql: '1 = 1', params: [] },
  };
  const parts: string[] = [];
  for (const table of DATA_TABLES) {
    const filter = filters[table];
    if (filter === undefined) throw new Error(`no filter for ${table}`);
    const rows = await world.db.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${filter.sql} ORDER BY rowid`, filter.params);
    parts.push(`${table}:${JSON.stringify(rows, (_k, v: unknown) => (v instanceof Uint8Array ? `bytes:${Array.from(v).join(',')}` : v))}`);
  }
  for (const path of world.files.paths().sort()) if (!ownFiles.includes(path)) parts.push(`file:${path}`);
  return parts.join('|');
}

describe('no inspection other than the target is touched (a hash of every table, files included)', () => {
  async function seedAll(): Promise<void> {
    await seedPackages(world, 4);
    await seedEveryTable(world);
    await world.mediaFile('p001', 'keep-1', 'uploaded');
    await world.mediaFile('p004', 'keep-2', 'pending');
    await world.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, '/api/inspections/p003', 'e', 'x', 5, 'p003')", [accountKey(ALICE)]);
    await world.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, '$refresh_error:p003', NULL, 'network', 5, 'p003')", [accountKey(ALICE)]);
  }

  it('the instrument sees a change: the hash moves when a row of another inspection moves', async () => {
    await seedAll();
    const before = await hashExcluding('p003');
    await world.db.run("UPDATE resource_cache SET body = 'changed' WHERE key = 'k-candidate'");
    expect(await hashExcluding('p003')).not.toBe(before);
  });

  it('control: the instrument does not move on its own, nor for a change to the target itself', async () => {
    await seedAll();
    const before = await hashExcluding('p003');
    expect(await hashExcluding('p003')).toBe(before);
    await world.db.run("UPDATE resource_cache SET body = 'changed' WHERE package_id = 'p003'");
    expect(await hashExcluding('p003')).toBe(before);
  });

  it('purging p003 leaves every other row and file byte for byte as it was', async () => {
    await seedAll();
    const before = await hashExcluding('p003');
    const result = await executeReconcilePlan(world.executeDeps(), await planOf('p003'));
    expect(result).toMatchObject({ kind: 'done', summary: { purged: 1 } });
    expect((await world.counts('p003')).resource_cache).toBe(0);
    expect(await hashExcluding('p003')).toBe(before);
  });

  it('quarantining p003 (given unsent data) changes only p003', async () => {
    await seedAll();
    await world.outbox('p003', 'pending');
    const before = await hashExcluding('p003');
    const result = await executeReconcilePlan(world.executeDeps(), await planOf('p003'));
    expect(result).toMatchObject({ kind: 'done', summary: { quarantined: 1 } });
    expect(await hashExcluding('p003')).toBe(before);
  });

  it('a user-confirmed removal of p003 changes only p003', async () => {
    await seedAll();
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p003'");
    await world.outbox('p003', 'pending');
    const mine = await world.mediaFile('p003', 'mine', 'pending');
    const before = await hashExcluding('p003', [mine]);
    expect(await purgeInspection(world.purgeDeps(), 'p003', { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest() })).toEqual({ kind: 'purged' });
    expect(await hashExcluding('p003', [mine])).toBe(before);
    expect(world.files.paths()).not.toContain(mine);
    expect((await world.counts('p003')).files).toBe(0);
  });
});
