import { beforeEach, describe, expect, it } from 'vitest';
import { quarantineInspection, unquarantineInspection } from './quarantine';
import { fingerprintOf, REASON_NOT_VISIBLE, type ReconcilePlan } from './reconcile-decision';
import { executeReconcilePlan } from './reconcile-execute';
import { issuePlanForTest } from './test-support/brands';
import { createPurgeWorld, type PurgeWorld } from './test-support/purge-world';
import { ALICE, BOB } from './test-support/reconcile-world';

let world: PurgeWorld;

beforeEach(async () => {
  world = await createPurgeWorld();
});

async function planOf(...hidden: string[]): Promise<ReconcilePlan> {
  world.server.hidden = new Set(hidden);
  const result = await world.decide();
  if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
  return result;
}

const flags = async (id: string): Promise<{ quarantine_source: string | null; purging: number } | undefined> =>
  (await world.db.query<{ quarantine_source: string | null; purging: number }>('SELECT quarantine_source, purging FROM work_package WHERE inspection_id = ?', [id]))[0];

async function seedEight(): Promise<void> {
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) await world.seedPurgeable(id);
}

describe('executeReconcilePlan accepts only the plan decideReconcile returned', () => {
  it('a hand-built plan with the right fingerprints and reasons is refused before anything is read or written', async () => {
    await seedEight();
    const real = await planOf('p2');
    expect(real.purge).toEqual(['p2']);
    const crafted: ReconcilePlan = {
      kind: 'plan',
      purge: ['p2'],
      quarantine: [],
      unquarantine: [],
      keep: [],
      deferred: [],
      unknownOwner: [],
      massSuspicious: false,
      allMissing: false,
      candidateCount: 8,
      account: ALICE,
      decidedAt: world.clock.now(),
      fingerprints: { p2: await fingerprintOf(world.db, 'p2') },
      reasons: { p2: [REASON_NOT_VISIBLE] },
      proof: real.proof,
    };
    const hash = await world.hash();
    expect(await executeReconcilePlan(world.executeDeps(), crafted)).toMatchObject({ kind: 'stopped', reason: 'plan_not_issued', summary: { purged: 0 } });
    expect(await world.hash()).toBe(hash);
    expect(world.purgingSignals).toEqual([]);
  });

  it('a spread copy and a parsed copy of a real plan are refused, and the real one is carried out', async () => {
    await seedEight();
    const plan = await planOf('p2');
    const hash = await world.hash();
    for (const copy of [{ ...plan }, JSON.parse(JSON.stringify(plan)) as ReconcilePlan]) {
      expect(await executeReconcilePlan(world.executeDeps(), copy)).toMatchObject({ kind: 'stopped', reason: 'plan_not_issued' });
    }
    expect(await world.hash()).toBe(hash);
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { purged: 1 } });
    expect((await world.counts('p2')).work_package).toBe(0);
  });

  it('a non-object and null are refused without throwing', async () => {
    for (const bad of [null, undefined, 'plan', 7]) {
      expect(await executeReconcilePlan(world.executeDeps(), bad as never)).toMatchObject({ kind: 'stopped', reason: 'plan_not_issued' });
    }
  });
});

describe('a missing fingerprint fails closed', () => {
  it('a quarantine the plan has no fingerprint for is skipped, and nothing is written', async () => {
    await seedEight();
    await world.seedFull('p9');
    const plan = await planOf('p9');
    expect(plan.quarantine).toEqual(['p9']);
    const hash = await world.hash();
    const result = await executeReconcilePlan(world.executeDeps(), issuePlanForTest({ ...plan, fingerprints: {} }));
    expect(result).toMatchObject({ kind: 'done', summary: { quarantined: 0, skippedChanged: 1 } });
    expect(await world.hash()).toBe(hash);
  });

  it('an un-quarantine the plan has no fingerprint for is skipped, and the quarantine stays', async () => {
    await seedEight();
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p4'");
    const plan = await planOf();
    expect(plan.unquarantine).toEqual(['p4']);
    const result = await executeReconcilePlan(world.executeDeps(), issuePlanForTest({ ...plan, fingerprints: {} }));
    expect(result).toMatchObject({ kind: 'done', summary: { unquarantined: 0, skippedChanged: 1 } });
    expect((await flags('p4'))?.quarantine_source).toBe('reconcile_missing');
  });

  it('the quarantine itself treats a missing fingerprint as a mismatch; only an explicit null means "no plan"', async () => {
    await world.seedFull('p9');
    const deps = { db: world.db, connector: world.connector, isBlocked: world.purgeDeps().isBlocked };
    expect(await quarantineInspection(deps, 'p9', { account: ALICE } as never)).toEqual({ kind: 'refused', reason: 'changed' });
    expect((await flags('p9'))?.quarantine_source).toBeNull();
    expect(await quarantineInspection(deps, 'p9', { account: ALICE, expectedFingerprint: null })).toMatchObject({ kind: 'quarantined' });
  });

  it('the un-quarantine treats a missing fingerprint as a mismatch', async () => {
    await world.seedFull('p9', { quarantine: 'reconcile_missing' });
    const deps = { db: world.db, connector: world.connector, isBlocked: world.purgeDeps().isBlocked };
    expect(await unquarantineInspection(deps, 'p9', { account: ALICE } as never)).toEqual({ kind: 'refused', reason: 'changed' });
    expect(await unquarantineInspection(deps, 'p9', { account: ALICE, expectedFingerprint: null } as never)).toEqual({ kind: 'refused', reason: 'changed' });
    expect((await flags('p9'))?.quarantine_source).toBe('reconcile_missing');
    expect(await unquarantineInspection(deps, 'p9', { account: ALICE, expectedFingerprint: await fingerprintOf(world.db, 'p9') })).toMatchObject({ kind: 'unquarantined' });
  });
});

describe('every purge of the candidates is a mass, however few they are', () => {
  it('two purges out of two candidates are not carried out even though two is below the "more than five" rule', async () => {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    const base = await planOf();
    const plan = issuePlanForTest({
      ...base,
      purge: ['p1', 'p2'],
      candidateCount: 2,
      massSuspicious: false,
      allMissing: false,
      fingerprints: { p1: await fingerprintOf(world.db, 'p1'), p2: await fingerprintOf(world.db, 'p2') },
      reasons: { p1: [REASON_NOT_VISIBLE], p2: [REASON_NOT_VISIBLE] },
    });
    const hash = await world.hash();
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { purged: 0, failures: { incoherent_plan: 2 } } });
    expect(await world.hash()).toBe(hash);
  });

  it('control: two purges out of three candidates are carried out', async () => {
    for (const id of ['p1', 'p2', 'p3']) await world.seedPurgeable(id);
    const base = await planOf();
    const plan = issuePlanForTest({
      ...base,
      purge: ['p1', 'p2'],
      candidateCount: 3,
      massSuspicious: false,
      allMissing: false,
      fingerprints: { p1: await fingerprintOf(world.db, 'p1'), p2: await fingerprintOf(world.db, 'p2') },
      reasons: { p1: [REASON_NOT_VISIBLE], p2: [REASON_NOT_VISIBLE] },
    });
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { purged: 2 } });
  });
});

describe('the run stops when the shared lease is lost', () => {
  it('a lease taken by another flow after the first inspection stops the run before the second', async () => {
    await seedEight();
    await world.seedFull('p9');
    await world.seedFull('pa');
    const plan = await planOf('p9', 'pa');
    expect(plan.quarantine).toEqual(['p9', 'pa']);
    const result = await executeReconcilePlan(
      world.executeDeps({
        onQuarantined: async () => {
          await world.db.run("UPDATE lease SET holder = 'thief' WHERE name = 'sync'");
        },
      }),
      plan,
    );
    expect(result).toMatchObject({ kind: 'stopped', reason: 'lease_lost', summary: { quarantined: 1 } });
    expect((await flags('p9'))?.quarantine_source).toBe('reconcile_missing');
    expect((await flags('pa'))?.quarantine_source).toBeNull();
  });

  it('control: without the theft both are quarantined', async () => {
    await seedEight();
    await world.seedFull('p9');
    await world.seedFull('pa');
    const plan = await planOf('p9', 'pa');
    expect(await executeReconcilePlan(world.executeDeps(), plan)).toMatchObject({ kind: 'done', summary: { quarantined: 2 } });
  });

  it('a lease lost in the middle of a purge stops it between steps with the tombstone kept', async () => {
    await seedEight();
    const plan = await planOf('p2');
    let steals = 0;
    const result = await executeReconcilePlan(
      world.executeDeps({
        onPurging: async () => {
          steals += 1;
          await world.db.run("UPDATE lease SET holder = 'thief' WHERE name = 'sync'");
        },
      }),
      plan,
    );
    expect(steals).toBe(1);
    expect(result).toMatchObject({ kind: 'stopped', reason: 'lease_lost' });
    expect((await flags('p2'))?.purging).toBe(1);
    expect((await world.counts('p2')).work_package).toBe(1);
  });
});

describe('quarantining orphans only the caller\'s own queued writes', () => {
  it("another account's pending write for the same inspection id is not held", async () => {
    await world.seedFull('p9', { unsent: false });
    await world.outbox('p9', 'pending');
    await world.outbox('p9', 'pending', { account: BOB });
    const deps = { db: world.db, connector: world.connector, isBlocked: world.purgeDeps().isBlocked };
    expect(await quarantineInspection(deps, 'p9', { account: ALICE, expectedFingerprint: null })).toMatchObject({ kind: 'quarantined', orphaned: 1 });
    const rows = await world.db.query<{ user_id: string; state: string }>('SELECT user_id, state FROM outbox WHERE inspection_id = ? ORDER BY seq', ['p9']);
    expect(rows).toEqual([
      { user_id: 'alice', state: 'orphaned' },
      { user_id: 'bob', state: 'pending' },
    ]);
  });
});
