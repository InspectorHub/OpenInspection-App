import { beforeEach, describe, expect, it } from 'vitest';
import { createManualClock, type ManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { DAY_MS } from './lock';
import { type LockOutcome, recordVerified, setRevoked } from './lock-state';
import { createCapacitorAppState, LOCK_CHECK_INTERVAL_MS, startLockMonitor } from './lock-monitor';
import { fakeAppState, fakeScheduler } from './test-support/fakes';

const NOW = 1_800_000_000_000;

let db: Db;
let clock: ManualClock;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
  clock = createManualClock(NOW);
  await recordVerified(db, NOW, 30);
});

function setup() {
  const scheduler = fakeScheduler();
  const appState = fakeAppState();
  const outcomes: LockOutcome[] = [];
  let signal: (() => void) | null = null;
  const monitor = startLockMonitor({
    db,
    clock,
    scheduler,
    appState,
    onOutcome: (o) => {
      outcomes.push(o);
      signal?.();
    },
  });
  /** Waits until `n` outcomes have been reported. */
  const reported = (n: number): Promise<void> =>
    new Promise((resolve) => {
      if (outcomes.length >= n) resolve();
      else signal = () => outcomes.length >= n && resolve();
    });
  return { scheduler, appState, outcomes, monitor, reported };
}

describe('interval re-evaluation', () => {
  it('runs every 60 seconds through the injected scheduler and reports the outcome', async () => {
    const { scheduler, outcomes, reported, monitor } = setup();
    expect(scheduler.lastMs()).toBe(LOCK_CHECK_INTERVAL_MS);
    expect(LOCK_CHECK_INTERVAL_MS).toBe(60_000);
    expect(outcomes).toHaveLength(0);

    scheduler.tick();
    await reported(1);
    expect(outcomes[0]).toEqual({ locked: false });

    clock.advance(31 * DAY_MS);
    scheduler.tick();
    await reported(2);
    expect(outcomes[1]).toEqual({ locked: true, reason: 'expired' });
    monitor.stop();
  });

  it('each evaluation persists the latest time seen', async () => {
    const { scheduler, reported, monitor } = setup();
    clock.advance(1234);
    scheduler.tick();
    await reported(1);
    const rows = await db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'max_seen_time'");
    expect(rows[0]?.value).toBe(String(NOW + 1234));
    monitor.stop();
  });

  it('a revocation stored while the app is open is seen on the next tick', async () => {
    const { scheduler, outcomes, reported, monitor } = setup();
    await setRevoked(db);
    scheduler.tick();
    await reported(1);
    expect(outcomes[0]).toEqual({ locked: true, reason: 'revoked' });
    monitor.stop();
  });
});

describe('app resume', () => {
  it('evaluates when the app returns to the foreground', async () => {
    const { appState, outcomes, reported, monitor } = setup();
    clock.advance(40 * DAY_MS);
    appState.emit(true);
    await reported(1);
    expect(outcomes[0]).toEqual({ locked: true, reason: 'expired' });
    monitor.stop();
  });

  it('a clock wound back while the app was in the background is caught on resume', async () => {
    const { appState, outcomes, reported, monitor, scheduler } = setup();
    clock.advance(DAY_MS);
    scheduler.tick();
    await reported(1);
    clock.set(NOW);
    appState.emit(true);
    await reported(2);
    expect(outcomes[1]).toEqual({ locked: true, reason: 'clock' });
    monitor.stop();
  });

  it('the interval stops in the background and starts again on resume', async () => {
    const { appState, scheduler, monitor } = setup();
    expect(scheduler.active()).toBe(1);
    appState.emit(false);
    expect(scheduler.active()).toBe(0);
    appState.emit(true);
    expect(scheduler.active()).toBe(1);
    appState.emit(true);
    expect(scheduler.active()).toBe(1);
    monitor.stop();
  });

  it('going to the background evaluates nothing (and the same resume evaluates, as a control)', async () => {
    const { appState, outcomes, monitor } = setup();
    clock.advance(40 * DAY_MS);
    appState.emit(false);
    await monitor.idle();
    expect(outcomes).toHaveLength(0);
    appState.emit(true);
    await monitor.idle();
    expect(outcomes).toHaveLength(1);
    monitor.stop();
  });
});

describe('stop', () => {
  it('removes the interval and the resume listener and ignores a result still in flight', async () => {
    const { scheduler, appState, outcomes, monitor } = setup();
    const pending = monitor.checkNow();
    monitor.stop();
    await pending;
    expect(outcomes).toHaveLength(0);
    expect(scheduler.active()).toBe(0);
    expect(appState.listeners()).toBe(0);
    scheduler.tick();
    appState.emit(true);
    expect(outcomes).toHaveLength(0);
  });

  it('works without a resume port: the interval alone runs', async () => {
    const scheduler = fakeScheduler();
    const outcomes: LockOutcome[] = [];
    const monitor = startLockMonitor({ db, clock, scheduler, onOutcome: (o) => outcomes.push(o) });
    await monitor.checkNow();
    expect(outcomes).toEqual([{ locked: false }]);
    monitor.stop();
  });
});

describe('overlapping triggers', () => {
  it('a resume and a tick together report in order, one after the other', async () => {
    const { scheduler, appState, outcomes, reported, monitor } = setup();
    clock.advance(31 * DAY_MS);
    appState.emit(true);
    scheduler.tick();
    await reported(2);
    expect(outcomes).toEqual([
      { locked: true, reason: 'expired' },
      { locked: true, reason: 'expired' },
    ]);
    monitor.stop();
  });
});

describe('an evaluation that fails', () => {
  it('is reported to onError and neither locks nor unlocks', async () => {
    const scheduler = fakeScheduler();
    const outcomes: LockOutcome[] = [];
    const errors: unknown[] = [];
    const broken: Db = { ...db, query: () => Promise.reject(new Error('disk I/O error')) };
    const monitor = startLockMonitor({ db: broken, clock, scheduler, onOutcome: (o) => outcomes.push(o), onError: (e) => errors.push(e) });
    await monitor.checkNow();
    expect(outcomes).toEqual([]);
    expect(errors).toHaveLength(1);
    monitor.stop();
  });
});

describe('createCapacitorAppState', () => {
  it('maps appStateChange to active/inactive and removes the native listener on unsubscribe', async () => {
    let captured: ((event: { isActive: boolean }) => void) | null = null;
    let removed = 0;
    const app = {
      addListener: (_name: 'appStateChange', cb: (event: { isActive: boolean }) => void) => {
        captured = cb;
        return Promise.resolve({
          remove: () => {
            removed += 1;
            return Promise.resolve();
          },
        });
      },
    };
    const port = createCapacitorAppState(app);
    const seen: boolean[] = [];
    const off = port.onChange((a) => seen.push(a));
    (captured as ((event: { isActive: boolean }) => void) | null)?.({ isActive: true });
    (captured as ((event: { isActive: boolean }) => void) | null)?.({ isActive: false });
    expect(seen).toEqual([true, false]);
    off();
    await Promise.resolve();
    await Promise.resolve();
    expect(removed).toBe(1);
    (captured as ((event: { isActive: boolean }) => void) | null)?.({ isActive: true });
    expect(seen).toEqual([true, false]);
  });

  it('a plugin that refuses the listener leaves a port that never fires and does not throw', async () => {
    const app = { addListener: () => Promise.reject(new Error('no plugin')) };
    const port = createCapacitorAppState(app);
    const off = port.onChange(() => undefined);
    await Promise.resolve();
    expect(() => off()).not.toThrow();
  });
});
