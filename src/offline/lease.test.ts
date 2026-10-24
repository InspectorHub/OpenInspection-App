import { beforeEach, describe, expect, it } from 'vitest';
import { createManualClock, type ManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { acquireLease, DEFAULT_LEASE_TTL_MS, releaseLease, renewLease, SYNC_LEASE, withLease } from './lease';

let db: Db;
let clock: ManualClock;
const tokens = (...names: string[]) => {
  const queue = [...names];
  return () => queue.shift() ?? 'extra';
};

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
  clock = createManualClock(1_000_000);
});

describe('the shared lease', () => {
  it('is held by one acquirer at a time', async () => {
    const options = { clock, newToken: tokens('a', 'b') };
    expect(await acquireLease(db, 'sync', options)).toBe('a');
    expect(await acquireLease(db, 'sync', options)).toBeNull();
    await releaseLease(db, 'sync', 'a');
    expect(await acquireLease(db, 'sync', options)).toBe('b');
  });

  it('names are independent', async () => {
    const options = { clock, newToken: tokens('a', 'b') };
    expect(await acquireLease(db, 'sync', options)).toBe('a');
    expect(await acquireLease(db, 'other', options)).toBe('b');
  });

  it('a hung holder expires: after the ttl another acquirer takes over and the old holder cannot renew or release it', async () => {
    const options = { clock, ttlMs: 1000, newToken: tokens('hung', 'next') };
    expect(await acquireLease(db, 'sync', options)).toBe('hung');
    clock.advance(999);
    expect(await acquireLease(db, 'sync', options)).toBeNull();
    clock.advance(2);
    expect(await acquireLease(db, 'sync', options)).toBe('next');
    expect(await renewLease(db, 'sync', 'hung', options)).toBe(false);
    await releaseLease(db, 'sync', 'hung');
    expect(await db.query('SELECT holder FROM lease')).toEqual([{ holder: 'next' }]);
    expect(await renewLease(db, 'sync', 'next', options)).toBe(true);
  });

  it('renewing extends the expiry by the ttl from now', async () => {
    const options = { clock, ttlMs: 1000, newToken: tokens('a', 'b') };
    await acquireLease(db, 'sync', options);
    clock.advance(900);
    expect(await renewLease(db, 'sync', 'a', options)).toBe(true);
    clock.advance(900);
    expect(await acquireLease(db, 'sync', options)).toBeNull();
    clock.advance(200);
    expect(await acquireLease(db, 'sync', options)).toBe('b');
  });

  it('an expired lease nobody took can still be renewed by its holder', async () => {
    const options = { clock, ttlMs: 1000, newToken: tokens('a') };
    await acquireLease(db, 'sync', options);
    clock.advance(5000);
    expect(await renewLease(db, 'sync', 'a', options)).toBe(true);
  });

  it('a lease that outlives any ttl we grant (a clock set back) is treated as expired', async () => {
    const options = { clock, newToken: tokens('a', 'b') };
    await acquireLease(db, 'sync', options);
    clock.set(1_000_000 - 2 * 3_600_000);
    expect(await acquireLease(db, 'sync', options)).toBe('b');
  });

  it('the default ttl is a minute and the shared name is sync', () => {
    expect(DEFAULT_LEASE_TTL_MS).toBe(60_000);
    expect(SYNC_LEASE).toBe('sync');
  });
});

describe('withLease', () => {
  it('runs the work under the lease, blocks a second caller meanwhile (gated), and releases when done', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withLease(db, 'sync', { clock, newToken: tokens('one') }, async () => {
      entered();
      await gate;
      return 'first';
    });
    await inside;
    let ran = false;
    const second = await withLease(db, 'sync', { clock, newToken: tokens('two') }, () => {
      ran = true;
      return Promise.resolve('second');
    });
    expect(second).toEqual({ acquired: false });
    expect(ran).toBe(false);
    open();
    expect(await first).toEqual({ acquired: true, value: 'first' });
    expect(await db.query('SELECT count(*) AS n FROM lease')).toEqual([{ n: 0 }]);
    expect(await withLease(db, 'sync', { clock }, () => Promise.resolve(1))).toEqual({ acquired: true, value: 1 });
  });

  it('releases when the work throws', async () => {
    await expect(withLease(db, 'sync', { clock }, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await db.query('SELECT count(*) AS n FROM lease')).toEqual([{ n: 0 }]);
  });

  it('the handle renews while held and reports false once the lease was taken over', async () => {
    const result = await withLease(db, 'sync', { clock, ttlMs: 1000, newToken: tokens('mine') }, async (lease) => {
      const before = await lease.renew();
      clock.advance(5000);
      await acquireLease(db, 'sync', { clock, ttlMs: 1000, newToken: tokens('thief') });
      return { before, after: await lease.renew() };
    });
    expect(result).toEqual({ acquired: true, value: { before: true, after: false } });
    expect(await db.query('SELECT holder FROM lease')).toEqual([{ holder: 'thief' }]);
  });
});
