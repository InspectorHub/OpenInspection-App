import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_LEASE, acquireLease, releaseLease } from './lease';
import { cacheBytes } from './resource-cache';
import { failingDb } from './test-support/failing-db';
import { ALICE } from './test-support/replay-world';
import { ALICE_KEY, createPackageWorld, jsonReply, type PackageWorld } from './test-support/package-world';

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld();
});

const windowLists = (): number => w.pkg.requests.filter((r) => r.path === '/api/inspections' && r.query.has('dateFrom')).length;
const nonList = () => w.pkg.requests.filter((r) => r.path !== '/api/inspections');

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('the shared lease', () => {
  it('a refresh that finds the lease held makes no request and says so; the identical call succeeds once the lease is free', async () => {
    w.serve('t1');
    const token = await acquireLease(w.db, SYNC_LEASE, { clock: w.clock });
    expect(token).not.toBeNull();
    const busy = await w.run();
    expect(busy).toMatchObject({ leaseBusy: true, refreshed: 0, halted: null });
    expect(w.pkg.requests).toHaveLength(0);
    await releaseLease(w.db, SYNC_LEASE, token ?? '');
    expect(await w.run()).toMatchObject({ leaseBusy: false, refreshed: 1 });
  });

  it('while a refresh runs, the outbox replayer finds the lease busy and sends nothing', async () => {
    w.serve('t1');
    await w.queue('inspection.create', { id: 'new-1', propertyAddress: '12 Test Street', templateId: 'template-1' });
    const held = gate();
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/t1/results') await held.promise;
    };
    const flight = w.run();
    await vi.waitFor(() => expect(nonList().length).toBeGreaterThan(0));
    const replay = await w.replayer.replay();
    expect(replay).toMatchObject({ leaseBusy: true, sent: 0 });
    expect(w.server.requests).toHaveLength(0);
    held.open();
    await flight;
    expect(await w.replayer.replay()).toMatchObject({ leaseBusy: false, sent: 1 });
  });

  it('while the replayer runs, a refresh finds the lease busy and sends nothing', async () => {
    w.serve('t1');
    await w.queue('inspection.create', { id: 'new-1', propertyAddress: '12 Test Street', templateId: 'template-1' });
    const held = gate();
    w.server.hook = async () => {
      await held.promise;
    };
    const replaying = w.replayer.replay();
    await vi.waitFor(() => expect(w.server.requests.length).toBeGreaterThan(0));
    const summary = await w.run();
    expect(summary.leaseBusy).toBe(true);
    expect(w.pkg.requests).toHaveLength(0);
    held.open();
    expect(await replaying).toMatchObject({ sent: 1 });
    expect(await w.run()).toMatchObject({ leaseBusy: false, refreshed: 1 });
  });

  it('a holder that hangs past the ttl loses the lease: it stops, writes nothing, and does not release the new holder\'s lease', async () => {
    const short = w.build({ leaseTtlMs: 1000 });
    w.serve('t1');
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/t1') {
        w.clock.advance(2000);
        expect(await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, newToken: () => 'taker' })).toBe('taker');
      }
    };
    const summary = await short.refresh({ reason: 'manual' });
    expect(summary.halted).toBe('lease_lost');
    expect(nonList()).toHaveLength(1);
    expect(await w.db.query('SELECT COUNT(*) AS n FROM resource_cache')).toEqual([{ n: 0 }]);
    expect(await w.db.query('SELECT holder FROM lease')).toEqual([{ holder: 'taker' }]);
  });

  it('releases the lease when the run ends, even when storage fails inside it', async () => {
    w.serve('t1');
    const flaky = failingDb(w.db, /INSERT INTO work_package/, 1);
    const summary = await w.build({ db: flaky }).refresh({ reason: 'manual' });
    expect(summary.halted).toBe('storage_failed');
    expect(flaky.failures()).toBe(1);
    expect(w.refreshErrors).toHaveLength(1);
    expect(await w.db.query('SELECT COUNT(*) AS n FROM lease')).toEqual([{ n: 0 }]);
  });
});

describe('triggers', () => {
  it('concurrent refreshes share one run', async () => {
    w.serve('t1');
    const [first, second] = await Promise.all([w.refresher.refresh({ reason: 'manual' }), w.refresher.refresh({ reason: 'manual' })]);
    expect(first).toBe(second);
    expect(windowLists()).toBe(1);
  });

  it('triggers during a run make exactly one more run after it', async () => {
    w.serve('t1');
    const held = gate();
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/t1') await held.promise;
    };
    const flight = w.run('start');
    await vi.waitFor(() => expect(nonList().length).toBeGreaterThan(0));
    w.refresher.trigger('online');
    w.refresher.trigger('foreground');
    w.refresher.trigger('manual');
    held.open();
    await flight;
    await w.refresher.idle();
    expect(windowLists()).toBe(2);
    await w.refresher.idle();
    expect(windowLists()).toBe(2);
  });

  it('a person asking during a run is not lost to a later automatic trigger: the follow-up still re-downloads what is fresh', async () => {
    w.serve('t1');
    await w.run('start');
    w.pkg.requests.length = 0;
    w.clock.advance(31_000);
    const held = gate();
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections' && request.query.has('dateFrom') && w.pkg.requests.length === 1) await held.promise;
    };
    const flight = w.run('start');
    await vi.waitFor(() => expect(w.pkg.requests).toHaveLength(1));
    w.refresher.trigger('manual');
    w.refresher.trigger('online');
    held.open();
    await flight;
    await w.refresher.idle();
    expect(w.pkg.forInspection('t1').sort()).toEqual(['/api/inspections/t1', '/api/inspections/t1/report-data', '/api/inspections/t1/results', '/api/inspections/t1/tags']);
  });

  it('start() runs once at once, and again on the network returning, the app coming to the front and an unlock', async () => {
    w.serve('t1');
    w.refresher.start();
    await w.refresher.idle();
    await vi.waitFor(() => expect(windowLists()).toBe(1));
    await w.refresher.idle();
    w.network.set(false);
    await w.refresher.idle();
    expect(windowLists()).toBe(1);
    w.clock.advance(31_000);
    w.network.set(true);
    await vi.waitFor(() => expect(windowLists()).toBe(2));
    await w.refresher.idle();
    w.appState.emit(false);
    await w.refresher.idle();
    expect(windowLists()).toBe(2);
    w.clock.advance(31_000);
    w.appState.emit(true);
    await vi.waitFor(() => expect(windowLists()).toBe(3));
    await w.refresher.idle();
    w.clock.advance(31_000);
    w.unlock();
    await vi.waitFor(() => expect(windowLists()).toBe(4));
    await w.refresher.idle();
  });

  it('start() twice subscribes once', async () => {
    w.refresher.start();
    w.refresher.start();
    await w.refresher.idle();
    expect(w.network.listeners()).toBe(1);
    expect(w.appState.listeners()).toBe(1);
    expect(w.unlockListeners.size).toBe(1);
  });

  it('a signed-in trigger refreshes, even when it is the first thing that happens', async () => {
    w.serve('t1');
    w.refresher.trigger('sign_in');
    await vi.waitFor(() => expect(windowLists()).toBe(1));
    await w.refresher.idle();
    expect(await w.cachedKeys('t1')).toHaveLength(3);
  });

  it('starting offline waits, schedules the slow fallback, and refreshes when the network returns', async () => {
    w.serve('t1');
    w.network.setQuietly(false);
    w.refresher.start();
    await w.refresher.idle();
    await vi.waitFor(() => expect(w.timers.pending()).toBe(1));
    expect(w.timers.delays()).toEqual([600_000]);
    expect(w.pkg.requests).toHaveLength(0);
    w.network.set(true);
    await vi.waitFor(() => expect(windowLists()).toBe(1));
    await w.refresher.idle();
  });

  it('the fallback timer starts a run', async () => {
    w.refresher.start();
    await w.refresher.idle();
    await vi.waitFor(() => expect(w.timers.pending()).toBe(1));
    const before = windowLists();
    w.clock.advance(31_000);
    w.timers.fireNext();
    await vi.waitFor(() => expect(windowLists()).toBe(before + 1));
    await w.refresher.idle();
  });

  it('a busy lease is asked again soon, not after the slow fallback', async () => {
    const token = await acquireLease(w.db, SYNC_LEASE, { clock: w.clock });
    w.refresher.start();
    await w.refresher.idle();
    await vi.waitFor(() => expect(w.timers.pending()).toBe(1));
    expect(w.timers.delays()).toEqual([3500]);
    await releaseLease(w.db, SYNC_LEASE, token ?? '');
    w.serve('t1');
    w.timers.fireNext();
    await vi.waitFor(() => expect(windowLists()).toBe(1));
    await w.refresher.idle();
  });

  it('nothing is scheduled when the refresher was never started', async () => {
    w.serve('t1');
    await w.run();
    expect(w.timers.pending()).toBe(0);
  });

  it('stop() is terminal: listeners and timers are gone and no event starts a request', async () => {
    w.serve('t1');
    w.refresher.start();
    await w.refresher.idle();
    await vi.waitFor(() => expect(w.timers.pending()).toBe(1));
    w.refresher.stop();
    expect(w.timers.pending()).toBe(0);
    expect(w.network.listeners()).toBe(0);
    expect(w.appState.listeners()).toBe(0);
    expect(w.unlockListeners.size).toBe(0);
    const before = w.pkg.requests.length;
    w.network.set(false);
    w.network.set(true);
    w.appState.emit(true);
    w.unlock();
    w.refresher.trigger('manual');
    w.refresher.start();
    await w.refresher.idle();
    expect(w.pkg.requests.length).toBe(before);
    expect(w.timers.pending()).toBe(0);
    expect(await w.run()).toMatchObject({ halted: 'stopped' });
  });

  it('stopping during a run leaves no timer behind', async () => {
    w.serve('t1');
    w.pkg.hook = (request) => {
      if (request.path === '/api/inspections/t1') w.refresher.stop();
    };
    w.refresher.start();
    await w.refresher.idle();
    expect(w.timers.pending()).toBe(0);
    expect(w.network.listeners()).toBe(0);
  });

  it('a throwing listener or reporter does not change what a run does', async () => {
    const noisy = w.build({
      onHalt: () => {
        throw new Error('listener failed');
      },
      onError: () => {
        throw new Error('reporter failed');
      },
    });
    w.state.session = { kind: 'relogin' };
    w.pkg.script.push(jsonReply(401, { success: false }));
    expect(await noisy.refresh({ reason: 'manual' })).toMatchObject({ halted: 'auth' });
  });
});

describe('the size cap', () => {
  async function seedTwo(): Promise<number> {
    w.serve('a');
    w.serve('b');
    await w.run();
    w.pkg.requests.length = 0;
    w.pkg.inspections.delete('a');
    return cacheBytes(w.db, ALICE_KEY);
  }

  it('drops the oldest clean inspection first when over the cap, keeps its package row, and then downloads', async () => {
    const total = await seedTwo();
    const tight = w.build({ limits: { cacheCapBytes: total - 1 } });
    const summary = await tight.refresh({ reason: 'manual' });
    expect(summary).toMatchObject({ halted: null, refreshed: 1 });
    expect(await w.cachedKeys('a')).toEqual([]);
    expect(await w.cachedKeys('b')).toHaveLength(3);
    expect(await w.db.query("SELECT refreshed_at FROM work_package WHERE inspection_id = 'a'")).toEqual([{ refreshed_at: 0 }]);
  });

  it.each([
    ['an outbox row', "INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, tenant_id, user_id) VALUES ('k', 1, 'inspection.patch', '{}', 'failed', 1, 'a', 'tenant-1', 'alice')"],
    ['a media row', "INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES ('m', 'a', 'photo', 'p', 'image/jpeg', '{}', 'uploaded', 1)"],
    ['a Yjs update', "INSERT INTO ydoc_updates (doc_name, data) VALUES ('results-a', x'00')"],
    ['a pin', "UPDATE work_package SET pinned = 1 WHERE inspection_id = 'a'"],
  ])('with %s on the oldest inspection nothing is evicted, and when the cap still cannot be met the run does not halt: the evicted one is a new download and is skipped', async (_name, protect) => {
    await seedTwo();
    await w.db.run(protect);
    const tight = w.build({ limits: { cacheCapBytes: 10 } });
    const summary = await tight.refresh({ reason: 'manual' });
    expect(summary).toMatchObject({ halted: null, refreshed: 0, skippedCacheFull: 1, cacheFull: true });
    expect(w.pkg.requests.length).toBeGreaterThan(0);
    expect(await w.cachedKeys('a')).toHaveLength(3);
    expect(await w.cachedKeys('b')).toEqual([]);
  });

  it('under the cap nothing is evicted', async () => {
    await seedTwo();
    const summary = await w.build({ limits: { cacheCapBytes: 1_000_000 } }).refresh({ reason: 'manual' });
    expect(summary).toMatchObject({ halted: null });
    expect(await w.cachedKeys('a')).toHaveLength(3);
  });

  it('a larger-than-allowed inspection is not stored, whatever the per-resource sizes', async () => {
    w = await createPackageWorld({ limits: { inspectionBytes: 200 } });
    w.serve('t1');
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 0, failed: 1 });
    expect(await w.cachedKeys('t1')).toEqual([]);
    expect(await w.db.query("SELECT key, body FROM resource_cache WHERE SUBSTR(key, 1, 15) = '$refresh_error:'")).toEqual([{ key: '$refresh_error:t1', body: 'too_large' }]);
  });
});

describe('who the account is', () => {
  it('keys everything by the signed-in account, never by anything the server sent', async () => {
    w.serve('t1', { inspectorId: ALICE.userId, row: { tenantId: 'tenant-evil', userId: 'mallory' } });
    await w.run();
    expect(await w.db.query('SELECT DISTINCT account_key FROM resource_cache')).toEqual([{ account_key: ALICE_KEY }]);
    expect(await w.db.query('SELECT tenant_id, user_id FROM work_package')).toEqual([{ tenant_id: ALICE.tenantId, user_id: ALICE.userId }]);
  });
});
