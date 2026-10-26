import { describe, expect, it, vi } from 'vitest';
import { createMediaStore } from '../media/store';
import { photoRecord } from '../media/test-support/fakes';
import { acquireLease, releaseLease, SYNC_LEASE } from '../offline/lease';
import { enqueue } from '../offline/outbox';
import { ALICE, deferred } from '../offline/test-support/replay-world';
import { jsonReply, NOW } from '../offline/test-support/package-world';
import { neverBlocked } from '../test-support/never-blocked';
import { LAUNCH_LEASE_MAX_WAITS, LAUNCH_LEASE_WAIT_MS, SWEEP_KEY, SWEEP_MIN_INTERVAL_MS, SWEEP_TIMEOUT_MS, TEMP_SWEEP_KEY } from './offline-stack';
import type { OfflineStack } from './offline-stack';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };
const HOUR = 3_600_000;

/** Lets every already-resolved promise run. Microtasks only: no timer, no clock. */
async function flush(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

const trail = (w: StackWorld): string[] => w.pkg.requests.map((r) => `${r.method} ${r.path}`);

/** The launch order: the first replay (the create), then the first reconcile (the visibility check), then the refresher (the list). */
function expectLaunchOrder(order: string[]): void {
  const create = order.indexOf('POST /api/inspections');
  const visible = order.indexOf('POST /api/client/inspections/visible');
  const list = order.indexOf('GET /api/inspections');
  expect(create).toBeGreaterThanOrEqual(0);
  expect(visible).toBeGreaterThan(create);
  expect(list).toBeGreaterThan(visible);
}

/** Every reconcile status the stack showed, with the requests made by then: the FIRST one is the first reconcile flow's outcome. */
function watchReconcile(stack: OfflineStack, w: StackWorld): { status: string; trail: string[] }[] {
  const seen: { status: string; trail: string[] }[] = [];
  stack.status.subscribe(() => {
    const status = stack.status.get().reconcile;
    if (status !== 'never') seen.push({ status, trail: trail(w) });
  });
  return seen;
}

/** The first reconcile flow ran after the first replay had sent the write, and was not turned away by it. */
function expectFirstFlowAfterReplay(seen: { status: string; trail: string[] }[], sent = 'POST /api/inspections'): void {
  expect(seen[0]?.status).toBe('done');
  expect(seen[0]?.trail).toContain(sent);
}

async function queueCreate(w: StackWorld): Promise<void> {
  await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
}

const MINT = '/api/inspections/insp-1/media/upload-url';
function mintAnswers(w: StackWorld): void {
  w.pkg.overrides.set(MINT, () => jsonReply(200, { success: true, data: { url: '/api/public/uploads/photo?token=payload0001.signature0001', key: 'tenant-1/inspections/insp-1/photos/p1.jpg', expiresAt: 9_999_999_999_999 } }));
}

describe('launch order: replay first run, reconcile first flow, refresher', () => {
  it('holds when the token is accepted while the first replay is running', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    let fired = false;
    w.pkg.hook = async (request) => {
      if (request.method === 'POST' && request.path === '/api/inspections' && !fired) {
        fired = true;
        w.verified.fire();
        await flush();
      }
    };
    const stack = w.make();
    const seen = watchReconcile(stack, w);
    stack.start();
    await stack.settled();
    await stack.idle();
    expect(fired).toBe(true);
    expectFirstFlowAfterReplay(seen);
    expectLaunchOrder(trail(w));
    await stack.stop();
  });

  it('holds when the token is accepted right after start, before the replayer has taken the lease', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const stack = w.make();
    const seen = watchReconcile(stack, w);
    stack.start();
    await flush(3);
    w.verified.fire();
    await stack.settled();
    await stack.idle();
    expectFirstFlowAfterReplay(seen);
    expectLaunchOrder(trail(w));
    await stack.stop();
  });

  it('holds when the very first request of any flow (here the upload mint) refreshes the token', async () => {
    const w = await createStackWorld();
    mintAnswers(w);
    await queueCreate(w);
    const seeding = createMediaStore({ db: w.replay.db, files: w.files, isBlocked: neverBlocked });
    await seeding.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    let fired = false;
    w.pkg.hook = () => {
      if (fired) return;
      fired = true;
      w.verified.fire();
    };
    const stack = w.make();
    const seen = watchReconcile(stack, w);
    stack.start();
    await stack.settled();
    await stack.idle();
    expectFirstFlowAfterReplay(seen);
    expectLaunchOrder(trail(w));
    await stack.stop();
  });

  it('holds when a write refused for an inspection the server no longer shows asks for a reconcile during the first replay', async () => {
    const w = await createStackWorld();
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.update', { inspectionId: 'ghost-1', changes: { sqft: 10 } }, { account: ALICE });
    const stack = w.make();
    const seen = watchReconcile(stack, w);
    stack.start();
    await stack.settled();
    await stack.idle();
    expectFirstFlowAfterReplay(seen, 'PATCH /api/inspections/ghost-1');
    await stack.stop();
  });

  it('waits for the first replay when another holder has the lease: nothing is reconciled or refreshed until the retry got through', async () => {
    const w = await createStackWorld();
    await queueCreate(w);
    const foreign = await acquireLease(w.replay.db, SYNC_LEASE, { clock: w.replay.clock });
    expect(foreign).not.toBeNull();
    const stack = w.make();
    stack.start();
    await vi.waitFor(() => expect(w.replay.timers.delays()).toContain(LAUNCH_LEASE_WAIT_MS));
    await flush();
    expect(trail(w)).toEqual([]);
    // A token accepted while the start sequence waits for the replayer does not start a reconcile ahead of it.
    w.verified.fire();
    await flush();
    expect(stack.reconciler.last.status).toBe('never');

    await releaseLease(w.replay.db, SYNC_LEASE, foreign ?? '');
    w.replay.timers.fireWithDelay(LAUNCH_LEASE_WAIT_MS);
    await stack.settled();
    await stack.idle();
    expectLaunchOrder(trail(w));
    await stack.stop();
  });

  it('does not wait for ever on a holder that never lets go: after a bounded number of retries it goes on', async () => {
    const w = await createStackWorld();
    await acquireLease(w.replay.db, SYNC_LEASE, { clock: w.replay.clock });
    const stack = w.make();
    stack.start();
    let finished = false;
    void stack.settled().then(() => {
      finished = true;
    });
    for (let waits = 0; waits < LAUNCH_LEASE_MAX_WAITS && !finished; waits += 1) {
      await vi.waitFor(() => expect(finished || w.replay.timers.delays().includes(LAUNCH_LEASE_WAIT_MS)).toBe(true));
      if (!finished) w.replay.timers.fireWithDelay(LAUNCH_LEASE_WAIT_MS);
    }
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(stack.reconciler.last.status).not.toBe('never');
    await stack.stop();
  });
});

describe('start then stop in the same tick', () => {
  it('leaves no listener, subscription or timer behind', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    stack.start();
    await stack.stop();
    await stack.settled();
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
    expect(w.pkg.requests).toEqual([]);
  });
});

describe('a sweep that never answers', () => {
  async function hung(w: StackWorld) {
    const gate = deferred();
    const files = {
      ...w.files,
      list: async (dir: string) => {
        await gate.promise;
        return w.files.list(dir);
      },
    };
    return { gate, files };
  }

  it('does not hold up the replay, the reconcile and the refresh; the uploader waits for the sweep or its timeout, then goes on', async () => {
    const w = await createStackWorld();
    mintAnswers(w);
    await queueCreate(w);
    const seeding = createMediaStore({ db: w.replay.db, files: w.files, isBlocked: neverBlocked });
    await seeding.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    const { gate, files } = await hung(w);
    const stack = w.make({ files });
    stack.start();
    await vi.waitFor(() => expect(trail(w)).toContain('GET /api/inspections'));
    expectLaunchOrder(trail(w));
    expect(w.replay.timers.delays()).toContain(SWEEP_TIMEOUT_MS);
    expect(w.plugin.starts.length).toBe(0);
    expect(trail(w).some((entry) => entry === `POST ${MINT}`)).toBe(false);

    w.replay.timers.fireWithDelay(SWEEP_TIMEOUT_MS);
    await stack.settled();
    await stack.idle();
    expect(w.diagnostics).toContain('sweep_timeout');
    expect(w.plugin.starts.length).toBe(1);

    // The abandoned sweep may still finish later; what it found is ignored.
    gate.resolve();
    await flush(500);
    expect((await w.replay.db.query('SELECT 1 FROM device_state WHERE key = ?', [SWEEP_KEY])).length).toBe(0);
    await stack.stop();
  });

  it('stopping while it hangs ends the start sequence and leaves no timer', async () => {
    const w = await createStackWorld();
    const { gate, files } = await hung(w);
    const stack = w.make({ files });
    stack.start();
    await vi.waitFor(() => expect(w.replay.timers.delays()).toContain(SWEEP_TIMEOUT_MS));
    await stack.stop();
    await stack.settled();
    gate.resolve();
    await flush();
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
  });
});

describe('the two sweep stamps', () => {
  async function seedOldFiles(w: StackWorld): Promise<void> {
    await w.files.write('media/orphan-1.jpg', new Uint8Array([1]));
    w.files.setMtime('media/orphan-1.jpg', NOW - 2 * HOUR);
    w.files.seedCache('upload-1234567.tmp', NOW - 8 * HOUR);
  }
  const stamp = async (w: StackWorld, key: string): Promise<string | undefined> => (await w.replay.db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [key]))[0]?.value;

  it('a completed run stamps the orphan sweep and the temp sweep separately', async () => {
    const w = await createStackWorld();
    await seedOldFiles(w);
    const stack = w.make();
    stack.start();
    await stack.settled();
    await stack.idle();
    await stack.stop();
    expect(await stamp(w, SWEEP_KEY)).toBe(String(NOW));
    expect(await stamp(w, TEMP_SWEEP_KEY)).toBe(String(NOW));
  });

  it('an upload row left `uploading` by a crash skips only the temp sweep: the orphan sweep is stamped and is not repeated at the next launch', async () => {
    const w = await createStackWorld();
    await seedOldFiles(w);
    const seeding = createMediaStore({ db: w.replay.db, files: w.files, isBlocked: neverBlocked });
    await seeding.put(photoRecord('p1'));
    await seeding.markState('p1', 'uploading');
    const first = w.make({ isLocked: () => false });
    first.start();
    await first.settled();
    await first.idle();
    await first.stop();
    expect(w.files.paths()).not.toContain('media/orphan-1.jpg');
    expect(w.files.cacheNames()).toEqual(['upload-1234567.tmp']);
    expect(await stamp(w, SWEEP_KEY)).toBe(String(NOW));
    expect(await stamp(w, TEMP_SWEEP_KEY)).toBeUndefined();

    await w.files.write('media/orphan-2.jpg', new Uint8Array([2]));
    w.files.setMtime('media/orphan-2.jpg', NOW - 2 * HOUR);
    const second = w.make({ isLocked: () => false });
    second.start();
    await second.settled();
    await second.idle();
    await second.stop();
    expect(w.files.paths()).toContain('media/orphan-2.jpg');
  });

  it('each stamp suppresses only its own sweep for the interval, and each sweeps again after it', async () => {
    const w = await createStackWorld();
    await seedOldFiles(w);
    const first = w.make();
    first.start();
    await first.settled();
    await first.idle();
    await first.stop();

    await seedOldFiles(w);
    w.replay.clock.advance(SWEEP_MIN_INTERVAL_MS - 1);
    const second = w.make();
    second.start();
    await second.settled();
    await second.idle();
    await second.stop();
    expect(w.files.paths()).toContain('media/orphan-1.jpg');
    expect(w.files.cacheNames()).toEqual(['upload-1234567.tmp']);

    w.replay.clock.advance(1);
    const third = w.make();
    third.start();
    await third.settled();
    await third.idle();
    await third.stop();
    expect(w.files.paths()).not.toContain('media/orphan-1.jpg');
    expect(w.files.cacheNames()).toEqual([]);
  });
});
