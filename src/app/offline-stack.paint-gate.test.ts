import { describe, expect, it, vi } from 'vitest';
import { enqueue } from '../offline/outbox';
import { ALICE } from '../offline/test-support/replay-world';
import { LAUNCH_PAINT_CAP_MS, SWEEP_KEY } from './offline-stack';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };

/** Lets every already-resolved promise run. Microtasks only: no timer, no clock. */
async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

const trail = (w: StackWorld): string[] => w.pkg.requests.map((r) => `${r.method} ${r.path}`);
const sweepStamp = (w: StackWorld): Promise<unknown[]> => w.replay.db.query('SELECT value FROM device_state WHERE key = ?', [SWEEP_KEY]);

async function queueCreate(w: StackWorld): Promise<void> {
  await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
}

function expectLaunchOrder(order: string[]): void {
  const create = order.indexOf('POST /api/inspections');
  const visible = order.indexOf('POST /api/client/inspections/visible');
  const list = order.indexOf('GET /api/inspections');
  expect(create).toBeGreaterThanOrEqual(0);
  expect(visible).toBeGreaterThan(create);
  expect(list).toBeGreaterThan(visible);
}

const DEFER = { deferLaunchUntilPainted: true } as const;

describe('the start sequence waits for the first paint of the work list', () => {
  it('nothing is sent, swept or scheduled before the list has painted: the only thing pending is the cap', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const stack = w.make(DEFER);
    stack.start();
    await flush();
    expect(trail(w)).toEqual([]);
    expect(await sweepStamp(w)).toEqual([]);
    expect(w.replay.timers.delays()).toEqual([LAUNCH_PAINT_CAP_MS]);
    await stack.stop();
  });

  it('the paint releases it, every ordering of the launch is kept, and the cap timer is cleared', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const stack = w.make(DEFER);
    stack.start();
    await flush();
    stack.markListPainted();
    await stack.settled();
    await stack.idle();
    expectLaunchOrder(trail(w));
    expect(await sweepStamp(w)).not.toEqual([]);
    expect(w.replay.timers.delays()).not.toContain(LAUNCH_PAINT_CAP_MS);
    await stack.stop();
  });

  it('the cap releases it when the list never paints', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const stack = w.make(DEFER);
    stack.start();
    await flush();
    expect(trail(w)).toEqual([]);
    w.replay.timers.fireWithDelay(LAUNCH_PAINT_CAP_MS);
    await stack.settled();
    await stack.idle();
    expectLaunchOrder(trail(w));
    await stack.stop();
  });

  it('a paint that came before start() does not make it wait at all', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const stack = w.make(DEFER);
    stack.markListPainted();
    stack.start();
    await stack.settled();
    await stack.idle();
    expectLaunchOrder(trail(w));
    expect(w.replay.timers.requested()).not.toContain(LAUNCH_PAINT_CAP_MS);
    await stack.stop();
  });

  it('a second paint signal changes nothing', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const stack = w.make(DEFER);
    stack.start();
    await flush();
    stack.markListPainted();
    stack.markListPainted();
    await stack.settled();
    await stack.idle();
    expect(trail(w).filter((line) => line === 'POST /api/inspections')).toHaveLength(1);
    await stack.stop();
  });

  it('stop() before the paint leaves no residue and starts nothing, and a late paint or cap is harmless', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const stack = w.make(DEFER);
    stack.start();
    await flush();
    await stack.stop();
    await flush();
    stack.markListPainted();
    await flush();
    expect(trail(w)).toEqual([]);
    expect(await sweepStamp(w)).toEqual([]);
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
  });

  it('while locked it still waits for the unlock, then for the paint', async () => {
    const w = await createStackWorld();
    w.lock.locked = true;
    await queueCreate(w);
    const stack = w.make(DEFER);
    stack.start();
    await flush();
    w.lock.locked = false;
    w.unlocks.note({ locked: true, reason: 'expired' });
    w.unlocks.note({ locked: false });
    await flush();
    expect(trail(w)).toEqual([]);
    stack.markListPainted();
    await stack.settled();
    await stack.idle();
    expectLaunchOrder(trail(w));
    await stack.stop();
  });

  it('without the option nothing waits (the existing behaviour): the launch runs at once and no cap timer is set', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const stack = w.make();
    stack.start();
    await stack.settled();
    await stack.idle();
    expectLaunchOrder(trail(w));
    expect(w.replay.timers.requested()).not.toContain(LAUNCH_PAINT_CAP_MS);
    await stack.stop();
  });
});

describe('the launch wait is measured', () => {
  it('reports launch_wait_ms: the time between start and the paint, and nothing when it did not wait', async () => {
    const w = await createStackWorld();
    const onTiming = vi.fn();
    const stack = w.make({ ...DEFER, onTiming });
    stack.start();
    await flush();
    w.replay.clock.advance(1234);
    stack.markListPainted();
    await stack.settled();
    expect(onTiming).toHaveBeenCalledExactlyOnceWith('launch_wait_ms', 1234);
    await stack.stop();

    const world = await createStackWorld();
    const plain = vi.fn();
    const other = world.make({ onTiming: plain });
    other.start();
    await other.settled();
    expect(plain).not.toHaveBeenCalled();
    await other.stop();
  });
});
