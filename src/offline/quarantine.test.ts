import { beforeEach, describe, expect, it } from 'vitest';
import { CollabBlockedError } from '../collab/connector';
import { createBlockedGuard } from './blocked';
import { countOrphanedOutbox, countWaitingUploads } from './waiting';
import { outboxCounts, readOutboxRow } from './outbox';
import { quarantineInspection, unquarantineInspection, type QuarantineDeps } from './quarantine';
import { fingerprintOf } from './reconcile-decision';
import { createReplayWorld } from './test-support/replay-world';
import { createPurgeWorld, type PurgeWorld } from './test-support/purge-world';
import { ALICE } from './test-support/reconcile-world';

let world: PurgeWorld;
let closed: string[];
let signalled: string[];
let restored: string[];

beforeEach(async () => {
  world = await createPurgeWorld();
  closed = [];
  signalled = [];
  restored = [];
});

function deps(overrides: Partial<QuarantineDeps> = {}): QuarantineDeps {
  return {
    db: world.db,
    connector: {
      closeFor: async (id) => {
        closed.push(id);
        await world.connector.closeFor(id);
      },
    },
    uploader: world.purgeDeps().uploader ?? { cancelFor: () => Promise.resolve() },
    isBlocked: world.purgeDeps().isBlocked,
    onQuarantined: (id) => {
      signalled.push(id);
    },
    onUnquarantined: (id) => {
      restored.push(id);
    },
    ...overrides,
  };
}

const flags = async (id: string): Promise<{ quarantine_source: string | null; purging: number } | undefined> => (await world.db.query<{ quarantine_source: string | null; purging: number }>('SELECT quarantine_source, purging FROM work_package WHERE inspection_id = ?', [id]))[0];

describe('quarantine', () => {
  it('sets the only quarantine source, holds the pending queue items as orphaned, closes the connection, cancels uploads and signals the editor, all for that inspection only', async () => {
    await world.seedFull('p1');
    await world.seedFull('p2');
    const open = world.connect('p2');
    await open.persistenceSynced;
    const other = world.connect('p1');
    await other.persistenceSynced;
    const keep = await world.data('p1');
    const before = await world.counts('p2');
    const outcome = await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: await fingerprintOf(world.db, 'p2') });
    expect(outcome).toEqual({ kind: 'quarantined', orphaned: 1 });
    expect(await flags('p2')).toEqual({ quarantine_source: 'reconcile_missing', purging: 0 });
    const queue = await world.db.query<{ state: string; last_error: string | null }>('SELECT state, last_error FROM outbox WHERE inspection_id = ? ORDER BY seq', ['p2']);
    expect(queue).toEqual([
      { state: 'orphaned', last_error: 'target_gone' },
      { state: 'failed', last_error: null },
    ]);
    // Nothing is deleted: every count is what it was.
    expect(await world.counts('p2')).toEqual(before);
    expect(world.connector.isOpen('p2')).toBe(false);
    expect(world.connector.isOpen('p1')).toBe(true);
    expect(closed).toEqual(['p2']);
    expect(world.cancelled).toEqual(['p2']);
    expect(signalled).toEqual(['p2']);
    expect(await world.data('p1')).toBe(keep);
    other.destroy();
  });

  it('after it, the connector refuses the inspection and the guard says blocked', async () => {
    await world.seedFull('p2');
    await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: null });
    expect(await world.purgeDeps().isBlocked('p2')).toBe(true);
    await expect(world.connect('p2').persistenceSynced).rejects.toBeInstanceOf(CollabBlockedError);
  });

  it('the orphaned items are counted on their own line, not as waiting uploads', async () => {
    await world.seedFull('p2');
    const before = await countWaitingUploads(world.db);
    await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: null });
    expect(await countOrphanedOutbox(world.db)).toBe(1);
    expect(await countWaitingUploads(world.db)).toBe(before - 1);
  });

  it('already quarantined: nothing changes and nothing is signalled', async () => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    const hash = await world.hash();
    expect(await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: null })).toEqual({ kind: 'unchanged' });
    expect(await world.hash()).toBe(hash);
    expect(signalled).toEqual([]);
  });

  it.each([
    ['another account', () => world.db.run("UPDATE work_package SET user_id = 'bob' WHERE inspection_id = 'p2'"), 'not_owner'],
    ['nobody', () => world.db.run('UPDATE work_package SET tenant_id = NULL, user_id = NULL WHERE inspection_id = ?', ['p2']), 'not_owner'],
    ['a tombstoned package', () => world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']), 'purging'],
    ['a package the server never acknowledged', () => world.db.run('UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = ?', ['p2']), 'unconfirmed'],
  ])('refuses %s and writes nothing', async (_name, change, reason) => {
    await world.seedFull('p2');
    await change();
    const hash = await world.hash();
    expect(await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: null })).toEqual({ kind: 'refused', reason });
    expect(await world.hash()).toBe(hash);
    expect(closed).toEqual([]);
  });

  it('control: the same package without any of those is quarantined', async () => {
    await world.seedFull('p2');
    expect(await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: null })).toMatchObject({ kind: 'quarantined' });
  });

  it('a package that does not exist, or an id that is not an id, is refused', async () => {
    expect(await quarantineInspection(deps(), 'ghost', { account: ALICE, expectedFingerprint: null })).toEqual({ kind: 'refused', reason: 'no_package' });
    expect(await quarantineInspection(deps(), '../x', { account: ALICE, expectedFingerprint: null })).toEqual({ kind: 'refused', reason: 'invalid_id' });
  });

  it('a changed fingerprint refuses, a missing one is allowed (the safe direction after an unsent finding)', async () => {
    await world.seedFull('p2');
    const planned = await fingerprintOf(world.db, 'p2');
    await world.outbox('p2', 'pending');
    const hash = await world.hash();
    expect(await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: planned })).toEqual({ kind: 'refused', reason: 'changed' });
    expect(await world.hash()).toBe(hash);
    expect(await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: null })).toMatchObject({ kind: 'quarantined' });
  });

  it('fails closed when the guard does not report the quarantine, leaving the quarantine in place', async () => {
    await world.seedFull('p2');
    const outcome = await quarantineInspection(deps({ isBlocked: () => Promise.resolve(false) }), 'p2', { account: ALICE, expectedFingerprint: null });
    expect(outcome).toEqual({ kind: 'failed', code: 'guard_not_effective' });
    expect((await flags('p2'))?.quarantine_source).toBe('reconcile_missing');
  });

  it('a connection that cannot be closed is reported but does not undo the quarantine; cancel and signal failures are ignored', async () => {
    await world.seedFull('p2');
    const outcome = await quarantineInspection(
      deps({
        connector: { closeFor: () => Promise.reject(new Error('injected')) },
        uploader: { cancelFor: () => Promise.reject(new Error('plugin gone')) },
        onQuarantined: () => {
          throw new Error('editor gone');
        },
      }),
      'p2',
      { account: ALICE, expectedFingerprint: null },
    );
    expect(outcome).toEqual({ kind: 'failed', code: 'close_failed' });
    expect((await flags('p2'))?.quarantine_source).toBe('reconcile_missing');
  });
});

describe('un-quarantine', () => {
  it('clears the source and puts the held writes back in line with no attempts used, in one step, and tells the others', async () => {
    await world.seedFull('p2');
    await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: null });
    const outcome = await unquarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: await fingerprintOf(world.db, 'p2') });
    expect(outcome).toEqual({ kind: 'unquarantined', restored: 1 });
    expect(await flags('p2')).toEqual({ quarantine_source: null, purging: 0 });
    expect(await outboxCounts(world.db, { inspectionId: 'p2' })).toMatchObject({ pending: 1, failed: 1, orphaned: 0 });
    expect(restored).toEqual(['p2']);
    expect(await world.purgeDeps().isBlocked('p2')).toBe(false);
  });

  it('a failure while restoring the queue leaves the quarantine in place (one transaction)', async () => {
    await world.seedFull('p2');
    await quarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: null });
    const real = world.db;
    const broken = {
      ...real,
      transaction: <T>(fn: (tx: typeof real) => Promise<T>) =>
        real.transaction((tx) =>
          fn({
            ...tx,
            run: (sql: string, params?: unknown[]) => (/UPDATE outbox SET state = 'pending'/.test(sql) ? Promise.reject(new Error('injected')) : tx.run(sql, params)),
          } as typeof real),
        ),
    } as typeof real;
    const outcome = await unquarantineInspection(deps({ db: broken }), 'p2', { account: ALICE, expectedFingerprint: await fingerprintOf(world.db, 'p2') });
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect((await flags('p2'))?.quarantine_source).toBe('reconcile_missing');
    expect(await outboxCounts(world.db, { inspectionId: 'p2' })).toMatchObject({ orphaned: 1 });
  });

  it('refuses a package that is being purged, one that is not quarantined, another account and a changed fingerprint', async () => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    const planned = await fingerprintOf(world.db, 'p2');
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    expect(await unquarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: await fingerprintOf(world.db, 'p2') })).toEqual({ kind: 'refused', reason: 'purging' });
    await world.db.run('UPDATE work_package SET purging = 0 WHERE inspection_id = ?', ['p2']);
    expect(await unquarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: planned })).toMatchObject({ kind: 'unquarantined' });
    expect(await unquarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: await fingerprintOf(world.db, 'p2') })).toEqual({ kind: 'unchanged' });
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing', user_id = 'bob' WHERE inspection_id = 'p2'");
    expect(await unquarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: await fingerprintOf(world.db, 'p2') })).toEqual({ kind: 'refused', reason: 'not_owner' });
    await world.db.run("UPDATE work_package SET user_id = 'alice' WHERE inspection_id = 'p2'");
    await world.outbox('p2', 'pending');
    expect(await unquarantineInspection(deps(), 'p2', { account: ALICE, expectedFingerprint: planned })).toEqual({ kind: 'refused', reason: 'changed' });
    expect((await flags('p2'))?.quarantine_source).toBe('reconcile_missing');
  });
});

describe('the queue seam: a quarantined inspection never blocks the others and comes back whole', () => {
  it('the replayer sends the other inspection, does not touch the held one, and sends it after the un-quarantine', async () => {
    const w = await createReplayWorld();
    w.server.inspections.set('held', { cancelled: false });
    w.server.inspections.set('free', { cancelled: false });
    await w.db.run('INSERT INTO work_package (inspection_id, refreshed_at, tenant_id, user_id) VALUES (?, 1, ?, ?)', ['held', ALICE.tenantId, ALICE.userId]);
    const held = await w.queue('inspection.update', { inspectionId: 'held', changes: { sqft: 1 } });
    await w.queue('inspection.update', { inspectionId: 'free', changes: { sqft: 2 } });
    const q = deps({ db: w.db, isBlocked: createBlockedGuard(w.db) });
    expect(await quarantineInspection(q, 'held', { account: ALICE, expectedFingerprint: null })).toMatchObject({ kind: 'quarantined', orphaned: 1 });
    expect(await w.replayer.replay()).toMatchObject({ sent: 1, failed: 0, halted: null });
    expect(w.server.requests.map((r) => new URL(r.url).pathname)).toEqual(['/api/inspections/free']);
    expect(await readOutboxRow(w.db, held.idempotencyKey)).toMatchObject({ state: 'orphaned', lastError: 'target_gone' });
    expect(await outboxCounts(w.db)).toMatchObject({ pending: 0, orphaned: 1, failed: 0 });
    expect(await unquarantineInspection(q, 'held', { account: ALICE, expectedFingerprint: await fingerprintOf(w.db, 'held') })).toMatchObject({ kind: 'unquarantined', restored: 1 });
    expect(await w.replayer.replay()).toMatchObject({ sent: 1 });
    expect(await w.rows()).toEqual([]);
  });
});
