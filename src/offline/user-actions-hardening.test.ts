import { beforeEach, describe, expect, it } from 'vitest';
import { issuePlanForTest } from './test-support/brands';
import { createPurgeWorld, type PurgeWorld } from './test-support/purge-world';
import { ALICE, BOB } from './test-support/reconcile-world';
import { discardMedia, discardOutboxRow, listUnattributableOutbox, removeFromDevice, type UserActionDeps } from './user-actions';
import type { ReconcilePlan } from './reconcile-decision';

let world: PurgeWorld;

beforeEach(async () => {
  world = await createPurgeWorld();
});

function deps(overrides: Partial<UserActionDeps> = {}): UserActionDeps {
  return { ...world.purgeDeps(), clock: world.clock, account: () => world.state.account, isLocked: () => world.state.locked, ...overrides };
}

async function planOf(...hidden: string[]): Promise<ReconcilePlan> {
  world.server.hidden = new Set(hidden);
  const result = await world.decide();
  if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
  return result;
}

const mediaIds = async (): Promise<string[]> => (await world.db.query<{ pending_id: string }>('SELECT pending_id FROM media ORDER BY pending_id')).map((r) => r.pending_id);

describe('discardMedia is scoped to the signed-in account and to inspections that are not healthy', () => {
  it("never deletes a photo of another account's inspection, file included", async () => {
    await world.pkg('b1', { account: BOB, quarantine: 'reconcile_missing' });
    await world.mediaFile('b1', 'bobphoto', 'pending');
    const hash = await world.hash();
    expect(await discardMedia(deps(), 'bobphoto', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_removable' });
    expect(await world.hash()).toBe(hash);
    expect(world.files.paths()).toContain('media/bobphoto.jpg');
  });

  it('never deletes a photo of a healthy inspection, whatever state the photo is in', async () => {
    await world.pkg('h1');
    for (const state of ['pending', 'uploading', 'failed', 'uploaded']) await world.mediaFile('h1', `ph-${state}`, state);
    const hash = await world.hash();
    for (const state of ['pending', 'uploading', 'failed', 'uploaded']) {
      expect(await discardMedia(deps(), `ph-${state}`, { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_removable' });
    }
    expect(await world.hash()).toBe(hash);
    expect(world.files.paths()).toHaveLength(4);
  });

  it('half an owner is not the caller: a package with only the tenant (or only the user) set is not removable from here', async () => {
    await world.pkg('q1', { quarantine: 'reconcile_missing' });
    await world.mediaFile('q1', 'half', 'pending');
    await world.db.run('UPDATE work_package SET user_id = NULL WHERE inspection_id = ?', ['q1']);
    expect(await discardMedia(deps(), 'half', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_removable' });
    await world.db.run('UPDATE work_package SET user_id = ?, tenant_id = NULL WHERE inspection_id = ?', [ALICE.userId, 'q1']);
    expect(await discardMedia(deps(), 'half', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_removable' });
    await world.db.run('UPDATE work_package SET user_id = ?, tenant_id = ? WHERE inspection_id = ?', [ALICE.userId, 'other-tenant', 'q1']);
    expect(await discardMedia(deps(), 'half', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_removable' });
    expect(await mediaIds()).toEqual(['half']);
    // Control: the same row with the full owner is removed.
    await world.db.run('UPDATE work_package SET user_id = ?, tenant_id = ? WHERE inspection_id = ?', [ALICE.userId, ALICE.tenantId, 'q1']);
    expect(await discardMedia(deps(), 'half', { confirmed: true })).toEqual({ kind: 'discarded', inspectionId: 'q1' });
  });

  it('removes a photo of a quarantined inspection of this account, and of one the person is purging', async () => {
    await world.pkg('q1', { quarantine: 'reconcile_missing' });
    await world.mediaFile('q1', 'qp', 'pending');
    await world.pkg('u1', { purging: 2 });
    await world.mediaFile('u1', 'up', 'pending');
    expect(await discardMedia(deps(), 'qp', { confirmed: true })).toEqual({ kind: 'discarded', inspectionId: 'q1' });
    expect(await discardMedia(deps(), 'up', { confirmed: true })).toEqual({ kind: 'discarded', inspectionId: 'u1' });
    expect(world.files.paths()).toEqual([]);
  });

  it('a photo of an inspection a purge decided on its own is left to that purge', async () => {
    await world.pkg('a1', { purging: 1 });
    await world.mediaFile('a1', 'ap', 'pending');
    expect(await discardMedia(deps(), 'ap', { confirmed: true })).toEqual({ kind: 'refused', reason: 'purging' });
    expect(await mediaIds()).toEqual(['ap']);
  });

  it('an orphan row (no package row at all) is removed', async () => {
    await world.mediaFile('gone', 'orphan', 'failed');
    expect(await discardMedia(deps(), 'orphan', { confirmed: true })).toEqual({ kind: 'discarded', inspectionId: 'gone' });
    expect(await mediaIds()).toEqual([]);
    expect(world.files.paths()).toEqual([]);
  });

  it('refuses with no signed-in account, and an account that cannot be read, and changes nothing', async () => {
    await world.pkg('q1', { quarantine: 'reconcile_missing' });
    await world.mediaFile('q1', 'qp', 'pending');
    const hash = await world.hash();
    expect(await discardMedia(deps({ account: () => null }), 'qp', { confirmed: true })).toEqual({ kind: 'refused', reason: 'no_account' });
    expect(
      await discardMedia(
        deps({
          account: () => {
            throw new Error('unreadable');
          },
        }),
        'qp',
        { confirmed: true },
      ),
    ).toEqual({ kind: 'refused', reason: 'no_account' });
    expect(await world.hash()).toBe(hash);
  });
});

describe('the destructive actions refuse while the device is locked', () => {
  const lockStates: [string, Partial<UserActionDeps>][] = [
    ['locked', { isLocked: () => true }],
    ['a lock check that throws', { isLocked: () => Promise.reject(new Error('unreadable')) }],
    ['a lock check that answers something that is not false', { isLocked: (() => undefined) as unknown as UserActionDeps['isLocked'] }],
  ];

  it.each(lockStates)('removeFromDevice: %s', async (_name, override) => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    const hash = await world.hash();
    expect(await removeFromDevice(deps(override), 'p2', { confirmed: true })).toEqual({ kind: 'locked' });
    expect(await world.hash()).toBe(hash);
    expect(world.purgingSignals).toEqual([]);
    // Control: the same call on the same inspection once the device is unlocked.
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'purged' });
  });

  it.each(lockStates)('discardMedia: %s', async (_name, override) => {
    await world.pkg('q1', { quarantine: 'reconcile_missing' });
    await world.mediaFile('q1', 'qp', 'pending');
    const hash = await world.hash();
    expect(await discardMedia(deps(override), 'qp', { confirmed: true })).toEqual({ kind: 'locked' });
    expect(await world.hash()).toBe(hash);
    expect(await discardMedia(deps(), 'qp', { confirmed: true })).toMatchObject({ kind: 'discarded' });
  });

  it.each(lockStates)('discardOutboxRow: %s', async (_name, override) => {
    await world.outbox(null, 'pending');
    const key = (await world.db.query<{ idempotency_key: string }>('SELECT idempotency_key FROM outbox'))[0]?.idempotency_key ?? '';
    const hash = await world.hash();
    expect(await discardOutboxRow(deps(override), key, { confirmed: true })).toEqual({ kind: 'locked' });
    expect(await world.hash()).toBe(hash);
    expect(await discardOutboxRow(deps(), key, { confirmed: true })).toMatchObject({ kind: 'discarded' });
  });

  it('listing is read-only and still works while locked', async () => {
    await world.outbox(null, 'pending');
    expect((await listUnattributableOutbox(world.db, ALICE)).rows).toHaveLength(1);
  });

  it('a lock that arrives in the middle of a removal stops it at the next step with the tombstone kept', async () => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    let asked = 0;
    const result = await removeFromDevice(deps({ isLocked: () => (asked += 1) > 3 }), 'p2', { confirmed: true });
    expect(result).toMatchObject({ kind: 'failed', code: 'interrupted' });
    const flag = await world.db.query<{ purging: number }>('SELECT purging FROM work_package WHERE inspection_id = ?', ['p2']);
    expect(Number(flag[0]?.purging)).toBe(2);
    expect((await world.counts('p2')).work_package).toBe(1);
  });
});

describe('an unattributable queued write belongs to the caller only when BOTH its tenant and its user are the caller', () => {
  it('a row with only one owner field empty is foreign: not listed as the caller\'s, not discardable', async () => {
    await world.db.run("INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, registry_version, tenant_id, user_id) VALUES ('half-1', 1, 'inspection.update', '{}', 'pending', 1, NULL, 1, NULL, ?)", [ALICE.userId]);
    await world.db.run("INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, registry_version, tenant_id, user_id) VALUES ('half-2', 2, 'inspection.update', '{}', 'pending', 1, NULL, 1, ?, NULL)", [ALICE.tenantId]);
    expect(await listUnattributableOutbox(world.db, ALICE)).toEqual({ rows: [], foreign: 2 });
    expect(await discardOutboxRow(deps(), 'half-1', { confirmed: true })).toEqual({ kind: 'refused', reason: 'foreign' });
    expect(await discardOutboxRow(deps(), 'half-2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'foreign' });
    expect(Number((await world.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM outbox'))[0]?.n)).toBe(2);
  });

  it('control: a row of nobody (both empty) and a row of the caller are the caller\'s', async () => {
    await world.db.run("INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, registry_version, tenant_id, user_id) VALUES ('nobody', 900, 'inspection.update', '{}', 'pending', 1, NULL, 1, NULL, NULL)");
    await world.outbox(null, 'pending');
    expect((await listUnattributableOutbox(world.db, ALICE)).rows).toHaveLength(2);
    expect(await discardOutboxRow(deps(), 'nobody', { confirmed: true })).toMatchObject({ kind: 'discarded' });
  });
});

describe('removeFromDevice accepts only a plan that decideReconcile issued', () => {
  async function threeSuspicious(): Promise<ReconcilePlan> {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    await world.seedPurgeable('p3');
    return planOf('p1', 'p2', 'p3');
  }

  it('a spread copy, a parsed copy and a hand-built plan with the right content are refused as not issued, and nothing changes', async () => {
    const plan = await threeSuspicious();
    const hash = await world.hash();
    for (const forged of [{ ...plan }, JSON.parse(JSON.stringify(plan)) as ReconcilePlan, { ...plan, quarantine: [...plan.quarantine], reasons: { ...plan.reasons } }]) {
      expect(await removeFromDevice(deps(), 'p2', { confirmed: true, plan: forged })).toEqual({ kind: 'refused', reason: 'plan_not_issued' });
    }
    expect(await world.hash()).toBe(hash);
  });

  it('control: the plan object decideReconcile returned removes the inspection', async () => {
    const plan = await threeSuspicious();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true, plan })).toEqual({ kind: 'purged' });
    expect((await world.counts('p2')).work_package).toBe(0);
    expect((await world.counts('p1')).work_package).toBe(1);
  });

  it('an issued plan cannot be edited into saying something else: it is frozen', async () => {
    const plan = await threeSuspicious();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.quarantine)).toBe(true);
    expect(Object.isFrozen(plan.reasons)).toBe(true);
    expect(() => plan.quarantine.push('p9')).toThrow(TypeError);
    expect(() => {
      (plan as { massSuspicious: boolean }).massSuspicious = false;
    }).toThrow(TypeError);
  });

  it('a registered fixture that is not about a suspicious answer still does not remove a healthy inspection', async () => {
    const plan = await threeSuspicious();
    const hash = await world.hash();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true, plan: issuePlanForTest({ ...plan, massSuspicious: false }) })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(hash);
  });
});
