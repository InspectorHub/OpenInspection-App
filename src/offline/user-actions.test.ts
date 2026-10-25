import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_MAX_AGE_MS, REASON_MASS_SUSPICIOUS, REASON_NOT_VISIBLE, type ReconcilePlan } from './reconcile-decision';
import { issuePlanForTest } from './test-support/brands';
import { unsentData } from './unsent';
import { discardMedia, discardOutboxRow, listUnattributableOutbox, removeFromDevice, type UserActionDeps } from './user-actions';
import { createPurgeWorld, type InspectionTable, type PurgeWorld } from './test-support/purge-world';
import { ALICE, BOB } from './test-support/reconcile-world';

let world: PurgeWorld;

beforeEach(async () => {
  world = await createPurgeWorld();
});

const ZERO: Record<InspectionTable | 'files', number> = { work_package: 0, outbox: 0, media: 0, ydoc_updates: 0, ydoc_sync: 0, resource_cache: 0, files: 0 };

function deps(overrides: Partial<UserActionDeps> = {}): UserActionDeps {
  return { ...world.purgeDeps(), clock: world.clock, account: () => world.state.account, isLocked: () => world.state.locked, ...overrides };
}

async function planOf(...hidden: string[]): Promise<ReconcilePlan> {
  world.server.hidden = new Set(hidden);
  const result = await world.decide();
  if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
  return result;
}

async function seedQuarantined(id: string): Promise<void> {
  await world.seedFull(id, { quarantine: 'reconcile_missing' });
  await world.db.run("UPDATE outbox SET state = 'orphaned', last_error = 'target_gone' WHERE inspection_id = ? AND state = 'pending'", [id]);
}

describe('removeFromDevice', () => {
  it.each([[{}], [{ confirmed: false }], [{ confirmed: 'yes' }], [{ confirmed: 1 }]])('throws without an explicit confirmation (%j) and changes nothing', async (options) => {
    await seedQuarantined('p2');
    const hash = await world.hash();
    await expect(removeFromDevice(deps(), 'p2', options as { confirmed: true })).rejects.toThrow(/confirm/i);
    expect(await world.hash()).toBe(hash);
  });

  it('removes a quarantined inspection with everything it holds, files included, and touches no other inspection', async () => {
    await world.seedFull('p1');
    await seedQuarantined('p2');
    await world.seedFull('p3', { quarantine: 'reconcile_missing' });
    const keep = [await world.data('p1'), await world.data('p3')];
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
    expect([await world.data('p1'), await world.data('p3')]).toEqual(keep);
    expect(world.purgingSignals).toEqual(['p2']);
  });

  it('is not a way to wipe a healthy inspection: refused, and nothing changes', async () => {
    await world.seedFull('p2');
    const hash = await world.hash();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(hash);
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p2'");
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'purged' });
  });

  it('refuses an inspection the device has no package for, and one of another account', async () => {
    expect(await removeFromDevice(deps(), 'ghost', { confirmed: true })).toEqual({ kind: 'refused', reason: 'no_package' });
    await seedQuarantined('p2');
    await world.db.run("UPDATE work_package SET user_id = 'bob' WHERE inspection_id = 'p2'");
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_owner' });
    expect((await world.counts('p2')).work_package).toBe(1);
  });

  it('refuses with no signed-in account, and while another flow holds the lease', async () => {
    await seedQuarantined('p2');
    world.state.account = null;
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'no_account' });
    world.state.account = ALICE;
    await world.db.run("INSERT INTO lease (name, holder, expires_at) VALUES ('sync', 'replayer', ?)", [world.clock.now() + 30_000]);
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'busy' });
    expect((await world.counts('p2')).work_package).toBe(1);
  });

  it('a mass-suspicious answer: the id is removable straight from the latest plan, before any quarantine was written', async () => {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    await world.seedPurgeable('p3');
    const plan = await planOf('p1', 'p2', 'p3');
    expect(plan.reasons.p2).toEqual([REASON_MASS_SUSPICIOUS]);
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true, plan })).toEqual({ kind: 'purged' });
    expect((await world.counts('p2')).work_package).toBe(0);
    expect((await world.counts('p1')).work_package).toBe(1);
  });

  it.each([
    ['a plan that did not call the answer suspicious', (plan: ReconcilePlan): ReconcilePlan => ({ ...plan, massSuspicious: false })],
    ['a plan whose reason for the id is something else', (plan: ReconcilePlan): ReconcilePlan => ({ ...plan, reasons: { ...plan.reasons, p2: [REASON_NOT_VISIBLE] } })],
    ['a plan that does not name the id', (plan: ReconcilePlan): ReconcilePlan => ({ ...plan, quarantine: plan.quarantine.filter((id) => id !== 'p2') })],
    ['a plan for another account', (plan: ReconcilePlan): ReconcilePlan => ({ ...plan, account: BOB })],
  ])('refuses %s', async (_name, change) => {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    await world.seedPurgeable('p3');
    const plan = await planOf('p1', 'p2', 'p3');
    const hash = await world.hash();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true, plan: issuePlanForTest(change(plan)) })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(hash);
  });

  it('refuses a stale plan', async () => {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    await world.seedPurgeable('p3');
    const plan = await planOf('p1', 'p2', 'p3');
    world.clock.advance(DEFAULT_PLAN_MAX_AGE_MS + 1);
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true, plan })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
  });

  it('finishes a purge that stopped on its own (a stuck tombstone) when the person asks', async () => {
    await world.seedFull('p2');
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'purged' });
    await world.seedFull('p4');
    await world.db.run('UPDATE work_package SET purging = 2 WHERE inspection_id = ?', ['p4']);
    expect(await removeFromDevice(deps(), 'p4', { confirmed: true })).toEqual({ kind: 'purged' });
    expect(await world.counts('p4')).toEqual(ZERO);
  });

  it('reports a file that cannot be removed with a fixed code and keeps the tombstone', async () => {
    await seedQuarantined('p2');
    world.files.failRemoveFor('media/p2-m1.jpg');
    const result = await removeFromDevice(deps(), 'p2', { confirmed: true });
    expect(result).toEqual({ kind: 'failed', step: 'files', code: 'file_remove_failed' });
    expect(JSON.stringify(result)).not.toContain('media/');
  });
});

describe('removeFromDevice: an inspection that was never sent', () => {
  /** Made on this device (server_confirmed = 0) with its photos, document, cache and edits, and no create queued any more. */
  async function seedNeverSent(id: string): Promise<void> {
    await world.seedFull(id);
    await world.db.run('UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = ?', [id]);
  }

  it('removes it with everything it holds for the account that owns it, and touches no other inspection', async () => {
    await world.seedFull('p1');
    await seedNeverSent('p2');
    await world.seedFull('p3', { quarantine: 'reconcile_missing' });
    expect((await world.counts('p2')).outbox).toBeGreaterThan(0);
    expect((await world.counts('p2')).media).toBeGreaterThan(0);
    const keep = [await world.data('p1'), await world.data('p3')];
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
    expect([await world.data('p1'), await world.data('p3')]).toEqual(keep);
    expect(world.purgingSignals).toEqual(['p2']);
  });

  it('still needs the explicit confirmation', async () => {
    await seedNeverSent('p2');
    const hash = await world.hash();
    await expect(removeFromDevice(deps(), 'p2', {} as { confirmed: true })).rejects.toThrow(/confirm/i);
    expect(await world.hash()).toBe(hash);
  });

  it.each([['pending'], ['failed'], ['orphaned']])('refuses it while a create is still queued (%s): create_pending, nothing changes', async (state) => {
    await seedNeverSent('p2');
    await world.outbox('p2', state, { op: 'inspection.create' });
    const hash = await world.hash();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'create_pending' });
    expect(await world.hash()).toBe(hash);
  });

  it('never makes a healthy, server-confirmed inspection removable', async () => {
    await world.seedFull('p2');
    const hash = await world.hash();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(hash);
  });

  it("refuses another account's never-sent inspection, and one that belongs to nobody", async () => {
    await seedNeverSent('p2');
    await world.db.run("UPDATE work_package SET user_id = 'bob' WHERE inspection_id = 'p2'");
    const hash = await world.hash();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_owner' });
    expect(await world.hash()).toBe(hash);
    await world.db.run('UPDATE work_package SET tenant_id = NULL, user_id = NULL WHERE inspection_id = ?', ['p2']);
    const hash2 = await world.hash();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_owner' });
    expect(await world.hash()).toBe(hash2);
  });

  it('is refused while the device is locked, with nothing changed', async () => {
    await seedNeverSent('p2');
    const hash = await world.hash();
    world.state.locked = true;
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'locked' });
    expect(await world.hash()).toBe(hash);
  });

  it("a create row of ANOTHER account for the same id counts as a create still queued: refused, nothing deleted", async () => {
    await seedNeverSent('p2');
    await world.outbox('p2', 'failed', { op: 'inspection.create', account: BOB });
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'create_pending' });
    expect((await world.counts('p2')).work_package).toBe(1);
  });
});

describe('discardMedia', () => {
  it('throws without an explicit confirmation and changes nothing', async () => {
    await seedQuarantined('p2');
    const hash = await world.hash();
    await expect(discardMedia(deps(), 'p2-m1', {} as { confirmed: true })).rejects.toThrow(/confirm/i);
    expect(await world.hash()).toBe(hash);
  });

  it('removes one photo (file first, then row) and nothing else, of any inspection', async () => {
    await seedQuarantined('p2');
    await world.seedFull('p3');
    const keep = await world.data('p3');
    expect(await discardMedia(deps(), 'p2-m1', { confirmed: true })).toEqual({ kind: 'discarded', inspectionId: 'p2' });
    expect(world.files.paths()).not.toContain('media/p2-m1.jpg');
    expect(world.files.paths()).toContain('media/p2-m2.jpg');
    expect((await world.counts('p2')).media).toBe(1);
    expect(await world.data('p3')).toBe(keep);
  });

  it('is the way out of "any photo row counts as unsent": once the last one is gone the predicate no longer lists it', async () => {
    await world.seedPurgeable('p2');
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p2'");
    await world.mediaFile('p2', 'only', 'failed');
    expect((await unsentData(world.db, 'p2', ALICE)).reasons).toContain('media_not_uploaded');
    await discardMedia(deps(), 'only', { confirmed: true });
    expect((await unsentData(world.db, 'p2', ALICE)).unsent).toBe(false);
  });

  it('refuses a photo of an inspection that a purge decided on its own; the same photo once the block is a quarantine is discarded', async () => {
    await world.seedFull('p2');
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    const hash = await world.hash();
    expect(await discardMedia(deps(), 'p2-m1', { confirmed: true })).toEqual({ kind: 'refused', reason: 'purging' });
    expect(await world.hash()).toBe(hash);
    await world.db.run("UPDATE work_package SET purging = 0, quarantine_source = 'reconcile_missing' WHERE inspection_id = ?", ['p2']);
    expect(await discardMedia(deps(), 'p2-m1', { confirmed: true })).toMatchObject({ kind: 'discarded' });
  });

  it('a file that is already gone is tolerated; a file that cannot be removed keeps the row', async () => {
    await seedQuarantined('p2');
    await world.files.remove('media/p2-m1.jpg');
    expect(await discardMedia(deps(), 'p2-m1', { confirmed: true })).toMatchObject({ kind: 'discarded' });
    world.files.failRemoveFor('media/p2-m2.jpg');
    expect(await discardMedia(deps(), 'p2-m2', { confirmed: true })).toEqual({ kind: 'failed', code: 'file_remove_failed' });
    expect((await world.counts('p2')).media).toBe(1);
  });

  it('a photo that is not there, or an id that is not an id, is reported and nothing is touched', async () => {
    const hash = await world.hash();
    expect(await discardMedia(deps(), 'nothing', { confirmed: true })).toEqual({ kind: 'not_found' });
    expect(await discardMedia(deps(), '../x', { confirmed: true })).toEqual({ kind: 'not_found' });
    expect(await world.hash()).toBe(hash);
  });

  it("a row whose path is not its own file name never makes this touch another photo's file", async () => {
    await world.seedFull('p1');
    await seedQuarantined('p2');
    await world.db.run("UPDATE media SET path = 'media/p1-m1.jpg' WHERE pending_id = 'p2-m1'");
    expect(await discardMedia(deps(), 'p2-m1', { confirmed: true })).toMatchObject({ kind: 'discarded' });
    expect(world.files.paths()).toContain('media/p1-m1.jpg');
  });
});

describe('the queued writes that name no inspection', () => {
  it('lists them, without their payloads, and leaves out ordinary rows', async () => {
    await world.seedFull('p1');
    await world.outbox(null, 'pending');
    await world.outbox('', 'failed');
    await world.outbox('a/b', 'pending');
    await world.outbox('bulk', 'pending');
    const rows = await listUnattributableOutbox(world.db, ALICE);
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows.map((r) => r.state).sort()).toEqual(['failed', 'pending', 'pending', 'pending']);
    expect(rows.foreign).toBe(0);
    expect(JSON.stringify(rows)).not.toContain('payload');
    expect(rows.rows.every((r) => typeof r.idempotencyKey === 'string' && typeof r.op === 'string')).toBe(true);
  });

  it('control: with only ordinary rows the list is empty', async () => {
    await world.seedFull('p1');
    expect(await listUnattributableOutbox(world.db, ALICE)).toEqual({ rows: [], foreign: 0 });
  });

  it("another account's rows are counted, not listed", async () => {
    await world.outbox(null, 'pending', { account: BOB });
    await world.outbox(null, 'pending');
    const rows = await listUnattributableOutbox(world.db, ALICE);
    expect(rows.rows).toHaveLength(1);
    expect(rows.foreign).toBe(1);
  });

  it('discarding one throws without a confirmation, and changes nothing', async () => {
    await world.outbox(null, 'pending');
    const hash = await world.hash();
    await expect(discardOutboxRow(deps(), 'key-1', {} as { confirmed: true })).rejects.toThrow(/confirm/i);
    expect(await world.hash()).toBe(hash);
  });

  it('returns the raw payload text for export, deletes exactly that row, and ends the refusal of the reconcile', async () => {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    await world.outbox(null, 'pending');
    await world.db.run("UPDATE outbox SET payload = 'not json {\"x\":1' WHERE inspection_id IS NULL");
    expect((await world.decide()).kind).toBe('refused');
    const keep = await world.data('p1');
    const result = await discardOutboxRow(deps(), 'key-1', { confirmed: true });
    expect(result).toEqual({ kind: 'discarded', idempotencyKey: 'key-1', op: 'inspection.update', payload: 'not json {"x":1' });
    expect(await world.db.query('SELECT 1 FROM outbox')).toEqual([]);
    expect(await world.data('p1')).toBe(keep);
    expect((await world.decide()).kind).toBe('plan');
  });

  it('is not a way to wipe an ordinary queue: a row that names its inspection is refused, and stays', async () => {
    await world.seedFull('p1');
    const ordinary = await world.db.query<{ idempotency_key: string }>("SELECT idempotency_key FROM outbox WHERE inspection_id = 'p1' LIMIT 1");
    const key = ordinary[0]?.idempotency_key ?? '';
    const before = await world.counts('p1');
    expect(await discardOutboxRow(deps(), key, { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_unattributable' });
    expect(await world.counts('p1')).toEqual(before);
  });

  it("refuses another account's row and reports a row that is not there", async () => {
    await world.outbox(null, 'pending', { account: BOB });
    expect(await discardOutboxRow(deps(), 'key-1', { confirmed: true })).toEqual({ kind: 'refused', reason: 'foreign' });
    expect(await world.db.query('SELECT 1 FROM outbox')).toHaveLength(1);
    expect(await discardOutboxRow(deps(), 'missing-key', { confirmed: true })).toEqual({ kind: 'not_found' });
  });

  it('a row of nobody (no tenant, no user) can be discarded by the signed-in person', async () => {
    await world.outbox(null, 'pending');
    await world.db.run('UPDATE outbox SET tenant_id = NULL, user_id = NULL');
    expect((await listUnattributableOutbox(world.db, ALICE)).rows).toHaveLength(1);
    expect(await discardOutboxRow(deps(), 'key-1', { confirmed: true })).toMatchObject({ kind: 'discarded' });
  });
});
