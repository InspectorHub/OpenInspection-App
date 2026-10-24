import { describe, expect, it } from 'vitest';
import { acquireLease, releaseLease, SYNC_LEASE, withLease } from './lease';
import { readOutboxRow } from './outbox';
import { createReplayWorld, deferred, failure, type ReplayWorld } from './test-support/replay-world';

const COMPLETE = (id: string) => ({ inspectionId: id });

function seed(w: ReplayWorld, ...ids: string[]): void {
  for (const id of ids) w.server.inspections.set(id, { cancelled: false });
}

describe('single flight', () => {
  it('concurrent replay() calls share one run and one request', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    const first = w.replayer.replay();
    const second = w.replayer.replay();
    expect(second).toBe(first);
    expect((await first).sent).toBe(1);
    expect(w.server.requests).toHaveLength(1);
  });

  it('triggers during a run make exactly one more run, which sends what was queued meanwhile', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    let runs = 0;
    const replayer = w.another({
      newToken: () => {
        runs += 1;
        return `holder-${String(runs)}`;
      },
    });
    const entered = deferred();
    const release = deferred();
    w.server.hook = async (_request, n) => {
      if (n !== 1) return;
      entered.resolve();
      await release.promise;
    };
    const running = replayer.replay();
    await entered.promise;
    await w.queue('inspection.complete', COMPLETE('b'));
    for (let i = 0; i < 5; i += 1) replayer.trigger();
    release.resolve();
    await running;
    await replayer.idle();
    expect(runs).toBe(2);
    expect(w.server.requests).toHaveLength(2);
    expect(await w.rows()).toEqual([]);
  });

  it('trigger() after an enqueue sends the new write', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.replayer.trigger();
    await w.replayer.idle();
    expect(await w.rows()).toEqual([]);
  });
});

describe('the lease shared with the other flows', () => {
  it('two replayers never run at once: the second finds the lease busy and sends nothing (gated)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    const entered = deferred();
    const release = deferred();
    w.server.hook = async (_request, n) => {
      if (n !== 1) return;
      entered.resolve();
      await release.promise;
    };
    const other = w.another();
    const first = w.replayer.replay();
    await entered.promise;
    const second = await other.replay();
    expect(second).toMatchObject({ sent: 0, leaseBusy: true });
    expect(w.server.requests).toHaveLength(1);
    release.resolve();
    expect((await first).sent).toBe(2);
    expect(w.server.requests).toHaveLength(2);
    expect((await other.replay()).leaseBusy).toBe(false);
  });

  it('a hung holder expires: the second replayer takes over after the ttl, and the repeat is the same keyed request', async () => {
    const w = await createReplayWorld({ leaseTtlMs: 10_000 });
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    const entered = deferred();
    const hang = deferred();
    w.server.hook = async (_request, n) => {
      if (n !== 1) return;
      entered.resolve();
      await hang.promise;
    };
    const other = w.another();
    const hung = w.replayer.replay();
    await entered.promise;
    w.clock.advance(5000);
    expect((await other.replay()).leaseBusy).toBe(true);
    expect(w.server.requests).toHaveLength(1);
    w.clock.advance(6000);
    expect((await other.replay()).sent).toBe(1);
    expect(w.server.requests).toHaveLength(2);
    expect(new Set(w.server.requests.map((r) => r.headers['Idempotency-Key']))).toEqual(new Set([row.idempotencyKey]));
    expect(w.server.keys.size).toBe(1);
    expect(await w.rows()).toEqual([]);
    hang.resolve();
    await hung;
  });

  it('a holder that loses the lease mid-run stops before its next request (positive control: otherwise it sends both)', async () => {
    const w = await createReplayWorld({ leaseTtlMs: 10_000 });
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    const second = await w.queue('inspection.complete', COMPLETE('b'));
    w.server.hook = async (_request, n) => {
      if (n !== 1) return;
      w.clock.advance(11_000);
      await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, ttlMs: 10_000, newToken: () => 'thief' });
    };
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, halted: 'lease_lost' });
    expect(w.server.requests).toHaveLength(1);
    expect(await readOutboxRow(w.db, second.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(await w.db.query('SELECT holder FROM lease')).toEqual([{ holder: 'thief' }]);

    const control = await createReplayWorld({ leaseTtlMs: 10_000 });
    seed(control, 'a', 'b');
    await control.queue('inspection.complete', COMPLETE('a'));
    await control.queue('inspection.complete', COMPLETE('b'));
    expect((await control.replayer.replay()).sent).toBe(2);
  });

  it('another flow holding the shared lease (reconcile, refresh) keeps the replayer from sending, until it lets go', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    const token = await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, newToken: () => 'reconcile' });
    expect(token).toBe('reconcile');
    expect((await w.replayer.replay()).leaseBusy).toBe(true);
    expect(w.server.requests).toHaveLength(0);
    await releaseLease(w.db, SYNC_LEASE, 'reconcile');
    expect((await w.replayer.replay()).sent).toBe(1);
  });

  it('the replayer holds the lease only while it runs, and the same lease blocks a flow started meanwhile', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    const entered = deferred();
    const release = deferred();
    w.server.hook = async () => {
      entered.resolve();
      await release.promise;
    };
    const run = w.replayer.replay();
    await entered.promise;
    expect(await withLease(w.db, SYNC_LEASE, { clock: w.clock }, () => Promise.resolve('reconcile ran'))).toEqual({ acquired: false });
    release.resolve();
    await run;
    expect(await w.db.query('SELECT count(*) AS n FROM lease')).toEqual([{ n: 0 }]);
    expect(await withLease(w.db, SYNC_LEASE, { clock: w.clock }, () => Promise.resolve('reconcile ran'))).toEqual({ acquired: true, value: 'reconcile ran' });
  });

  it('the lease is released when a run ends in a storage error', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    const original = w.db.query.bind(w.db);
    let broken = true;
    w.db.query = ((sql: string, params?: unknown[]) => (broken && sql.includes('FROM outbox o') ? Promise.reject(new Error('disk I/O error')) : original(sql, params))) as typeof w.db.query;
    await w.replayer.replay();
    expect(w.errors).toHaveLength(1);
    expect(await w.db.query('SELECT count(*) AS n FROM lease')).toEqual([{ n: 0 }]);
    broken = false;
    expect((await w.replayer.replay()).sent).toBe(1);
  });
});

describe('triggers', () => {
  it('start() runs at once and again when the network returns, the app comes to the foreground, or the device unlocks', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b', 'c', 'd');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.replayer.start();
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(1);
    expect(w.network.listeners()).toBe(1);
    expect(w.appState.listeners()).toBe(1);
    expect(w.unlockListeners.size).toBe(1);

    await w.queue('inspection.complete', COMPLETE('b'));
    w.network.set(true);
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(2);

    await w.queue('inspection.complete', COMPLETE('c'));
    w.appState.emit(true);
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(3);

    await w.queue('inspection.complete', COMPLETE('d'));
    w.appState.emit(false);
    w.network.set(false);
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(3);
    w.unlock();
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(3);
    w.network.set(true);
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(4);
    w.replayer.stop();
  });

  it('stop() is terminal: it unsubscribes, clears the timer, and a later replay sends nothing', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(failure(503, 'UNAVAILABLE'));
    w.replayer.start();
    await w.replayer.idle();
    expect(w.timers.pending()).toBe(1);
    w.replayer.stop();
    expect(w.timers.pending()).toBe(0);
    expect(w.network.listeners()).toBe(0);
    expect(w.appState.listeners()).toBe(0);
    expect(w.unlockListeners.size).toBe(0);
    w.clock.advance(3_600_000);
    w.network.set(true);
    w.unlock();
    expect(await w.replayer.replay()).toMatchObject({ sent: 0, halted: 'stopped' });
    w.replayer.trigger();
    w.replayer.start();
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(1);
    expect(w.network.listeners()).toBe(0);
  });

  it('stop() during a run ends it before the next request', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    w.server.hook = () => {
      w.replayer.stop();
    };
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, halted: 'stopped' });
    expect(w.server.requests).toHaveLength(1);
  });

  it('start() twice subscribes once', async () => {
    const w = await createReplayWorld();
    w.replayer.start();
    w.replayer.start();
    await w.replayer.idle();
    expect(w.network.listeners()).toBe(1);
    w.replayer.stop();
  });
});

describe('timers', () => {
  it('a waiting write arms one timer for the moment it is due; firing it sends the write', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(failure(503, 'UNAVAILABLE'));
    w.replayer.start();
    await w.replayer.idle();
    expect(w.timers.delays()).toEqual([1000]);
    w.clock.advance(1000);
    w.timers.fireNext();
    await w.replayer.idle();
    expect(await w.rows()).toEqual([]);
    expect(w.timers.pending()).toBe(0);
    w.replayer.stop();
  });

  it('a replayer that was not started arms no timer', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(failure(503, 'UNAVAILABLE'));
    await w.replayer.replay();
    expect(w.timers.pending()).toBe(1);
    w.replayer.stop();
    expect(w.timers.pending()).toBe(0);
  });

  it('a run cut short by the lock arms the slow fallback, jittered, and nothing else', async () => {
    const w = await createReplayWorld({ fallbackIntervalMs: 10_000 });
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.locked = true;
    w.replayer.start();
    await w.replayer.idle();
    expect(w.timers.delays()).toEqual([10_000]);
    w.state.locked = false;
    w.timers.fireNext();
    await w.replayer.idle();
    expect(await w.rows()).toEqual([]);
    expect(w.timers.pending()).toBe(0);
    w.replayer.stop();
  });

  it('a busy lease arms a short retry (2 to 5 s, jittered) so the write is not forgotten', async () => {
    const w = await createReplayWorld({ fallbackIntervalMs: 10_000 });
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, newToken: () => 'other-flow' });
    w.replayer.start();
    await w.replayer.idle();
    expect(w.timers.delays()).toEqual([3500]);
    await releaseLease(w.db, SYNC_LEASE, 'other-flow');
    w.timers.fireNext();
    await w.replayer.idle();
    expect(await w.rows()).toEqual([]);
    w.replayer.stop();
  });

  it('a failed write waits for a person: no timer at all', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(failure(422, 'VALIDATION_ERROR'));
    w.replayer.start();
    await w.replayer.idle();
    expect(w.timers.pending()).toBe(0);
    w.replayer.stop();
  });
});
