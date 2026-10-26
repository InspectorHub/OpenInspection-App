import { describe, expect, it } from 'vitest';
import { acquireLease, SYNC_LEASE } from './lease';
import { readOutboxRow } from './outbox';
import { createReplayWorld, type ReplayWorld } from './test-support/replay-world';

const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };

const stillThere = async (w: ReplayWorld, key: string): Promise<boolean> => (await readOutboxRow(w.db, key)) !== null;
const leaseRows = (w: ReplayWorld): Promise<unknown[]> => w.db.query('SELECT * FROM lease WHERE name = ?', [SYNC_LEASE]);

describe('replayer.discard honours the lock and the shared lease', () => {
  it('control: an unlocked, idle device discards the row and gives the lease back', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    expect(await w.replayer.discard(row.idempotencyKey, { confirmed: true })).toEqual({ kind: 'discarded' });
    expect(await stillThere(w, row.idempotencyKey)).toBe(false);
    expect(await leaseRows(w)).toEqual([]);
  });

  it('a row that is not there is reported as not_found, not as discarded', async () => {
    const w = await createReplayWorld();
    expect(await w.replayer.discard('no-such-key', { confirmed: true })).toEqual({ kind: 'not_found' });
    expect(await leaseRows(w)).toEqual([]);
  });

  it('a locked device keeps the create row', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    w.state.locked = true;
    expect(await w.replayer.discard(row.idempotencyKey, { confirmed: true })).toEqual({ kind: 'locked' });
    expect(await stillThere(w, row.idempotencyKey)).toBe(true);
    expect(await leaseRows(w)).toEqual([]);
  });

  it('a lock state that cannot be read counts as locked', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    w.state.lockedThrows = true;
    expect(await w.replayer.discard(row.idempotencyKey, { confirmed: true })).toEqual({ kind: 'locked' });
    expect(await stillThere(w, row.idempotencyKey)).toBe(true);
  });

  it('an answer that is not exactly false counts as locked', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    const odd = w.another({ isLocked: () => undefined as unknown as boolean });
    expect(await odd.discard(row.idempotencyKey, { confirmed: true })).toEqual({ kind: 'locked' });
    expect(await stillThere(w, row.idempotencyKey)).toBe(true);
  });

  it('another flow holding the lease makes it busy, and the row stays', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    expect(await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, newToken: () => 'other' })).toBe('other');
    expect(await w.replayer.discard(row.idempotencyKey, { confirmed: true })).toEqual({ kind: 'busy' });
    expect(await stillThere(w, row.idempotencyKey)).toBe(true);
  });

  it('a discard asked while a replay has the row in flight cannot overlap it: busy, and the replay still finishes', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    let during: unknown = null;
    w.server.hook = async () => {
      during = await w.replayer.discard(row.idempotencyKey, { confirmed: true });
    };
    const result = await w.replayer.replay();
    expect(during).toEqual({ kind: 'busy' });
    expect(result.sent).toBe(1);
    expect(await stillThere(w, row.idempotencyKey)).toBe(false);
  });

  it('still throws without the explicit confirmation, before it looks at anything', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    const untyped = w.replayer.discard as (key: string, options?: unknown) => Promise<unknown>;
    await expect(untyped(row.idempotencyKey)).rejects.toThrow();
    await expect(untyped(row.idempotencyKey, { confirmed: false })).rejects.toThrow();
    expect(await stillThere(w, row.idempotencyKey)).toBe(true);
  });
});
