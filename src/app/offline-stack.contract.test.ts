import { describe, expect, it, vi } from 'vitest';
import { createMediaStore } from '../media/store';
import { photoRecord } from '../media/test-support/fakes';
import { enqueue } from '../offline/outbox';
import { ALICE } from '../offline/test-support/replay-world';
import { jsonReply, NOW } from '../offline/test-support/package-world';
import { neverBlocked } from '../test-support/never-blocked';
import type { OfflineStack } from './offline-stack';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };
const HOUR = 3_600_000;

async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function run(stack: OfflineStack): Promise<void> {
  stack.start();
  await stack.settled();
  await stack.idle();
}

const paths = (w: StackWorld): string[] => w.pkg.requests.map((r) => `${r.method} ${r.path}`);
const count = (w: StackWorld, path: string): number => w.pkg.requests.filter((r) => r.path === path).length;
const VISIBLE = '/api/client/inspections/visible';
const SESSION = '/api/client/session';

/** A package the device holds that the server no longer lists: the check would remove it. */
async function holdGone(w: StackWorld): Promise<void> {
  w.pkg.overrides.set(VISIBLE, () => jsonReply(200, { success: true, data: { visible: [] } }));
  await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id) VALUES (?, 1, 0, 1, ?, ?)', ['gone-1', ALICE.tenantId, ALICE.userId]);
}

const rowsLeft = async (w: StackWorld): Promise<string[]> => (await w.replay.db.query<{ inspection_id: string }>('SELECT inspection_id FROM work_package')).map((r) => r.inspection_id);

describe('a server without the check for removed inspections (contract below 2)', () => {
  it('control: a server that has it is asked, and the missing inspection is found', async () => {
    const w = await createStackWorld();
    await holdGone(w);
    const stack = w.make({ reconcileSupported: () => true });
    await run(stack);
    expect(count(w, VISIBLE)).toBeGreaterThan(0);
    expect(count(w, SESSION)).toBeGreaterThan(0);
    expect(stack.reconciler.last.status).toBe('done');
    await stack.stop();
  });

  it('known to lack it: no session probe, no visible request, nothing removed or quarantined, everything else syncs', async () => {
    const w = await createStackWorld();
    await holdGone(w);
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    const stack = w.make({ reconcileSupported: () => false });
    await run(stack);
    expect(count(w, VISIBLE)).toBe(0);
    expect(count(w, SESSION)).toBe(0);
    expect(paths(w)).toContain('POST /api/inspections');
    expect(paths(w)).toContain('GET /api/inspections');
    expect(await rowsLeft(w)).toContain('gone-1');
    const flagged = await w.replay.db.query<{ purging: number; quarantine_source: string | null }>("SELECT purging, quarantine_source FROM work_package WHERE inspection_id = 'gone-1'");
    expect(flagged[0]).toEqual({ purging: 0, quarantine_source: null });
    expect(stack.reconciler.last).toMatchObject({ status: 'unavailable', reason: 'unsupported', unavailableRole: false });
    await stack.stop();
  });

  it('not known (no compat answer) it still tries; a 404 from the server then turns it off after ONE request, and removes nothing', async () => {
    const w = await createStackWorld();
    await holdGone(w);
    w.pkg.overrides.set(VISIBLE, () => jsonReply(404, { success: false }));
    let supported: boolean | null = null;
    const noted = vi.fn(() => {
      supported = false;
    });
    const stack = w.make({ reconcileSupported: () => supported, onReconcileUnsupported: noted });
    await run(stack);
    expect(count(w, VISIBLE)).toBe(1);
    expect(noted).toHaveBeenCalledTimes(1);
    expect(await rowsLeft(w)).toContain('gone-1');
    expect(stack.reconciler.last).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
    stack.reconciler.trigger('manual');
    await stack.idle();
    stack.reconciler.trigger('foreground');
    await stack.idle();
    expect(count(w, VISIBLE)).toBe(1);
    expect(count(w, SESSION)).toBeLessThanOrEqual(1);
    await stack.stop();
  });

  it('a reporter that throws changes nothing', async () => {
    const w = await createStackWorld();
    await holdGone(w);
    w.pkg.overrides.set(VISIBLE, () => jsonReply(405, { success: false }));
    const stack = w.make({
      onReconcileUnsupported: () => {
        throw new Error('reporter failed');
      },
    });
    await run(stack);
    expect(stack.reconciler.last.reason).toBe('unsupported');
    expect(await rowsLeft(w)).toContain('gone-1');
    await stack.stop();
  });
});

describe('the contract is looked at again when the link comes back, only while still unknown', () => {
  it('started offline: nothing is asked; the first online edge asks once, and an edge while that look runs asks for nothing more', async () => {
    const w = await createStackWorld();
    w.replay.network.setQuietly(false);
    let release: () => void = () => undefined;
    const beforeLaunch = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const stack = w.make({ beforeLaunch, compatKnown: () => false });
    await run(stack);
    expect(beforeLaunch).not.toHaveBeenCalled();
    w.replay.network.set(true);
    await flush();
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    w.replay.network.set(false);
    w.replay.network.set(true);
    await flush();
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await stack.stop();
  });

  it('control: once an answer is known, an online edge asks for nothing; an offline edge never asks', async () => {
    const w = await createStackWorld();
    let known = false;
    const beforeLaunch = vi.fn(() => {
      known = true;
      return Promise.resolve();
    });
    const stack = w.make({ beforeLaunch, compatKnown: () => known });
    await run(stack);
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    w.replay.network.set(false);
    w.replay.network.set(true);
    await flush();
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    await stack.stop();
  });

  it('what the look learns on the edge stops the flows when the server is too old (no restart, no foreground)', async () => {
    const w = await createStackWorld();
    w.replay.network.setQuietly(false);
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    const tooOld = { value: false, listeners: new Set<() => void>() };
    const stack = w.make({
      serverTooOld: {
        get: () => tooOld.value,
        subscribe: (listener) => {
          tooOld.listeners.add(listener);
          return () => tooOld.listeners.delete(listener);
        },
      },
      beforeLaunch: () => {
        tooOld.value = true;
        for (const listener of [...tooOld.listeners]) listener();
        return Promise.resolve();
      },
      compatKnown: () => false,
    });
    await run(stack);
    w.replay.network.set(true);
    await flush();
    await stack.idle();
    expect(w.pkg.requests).toEqual([]);
    await stack.stop();
  });

  it('a stack that has stopped leaves no listener on the network', async () => {
    const w = await createStackWorld();
    const stack = w.make({ beforeLaunch: () => Promise.resolve(), compatKnown: () => false });
    await run(stack);
    await stack.stop();
    expect(w.residue().network).toBe(0);
  });
});

describe('the look at the contract does not hold the local sweeps back', () => {
  it('the sweeps run while the look is still waiting for the server; the uploader and the replay wait for it', async () => {
    const w = await createStackWorld();
    await w.files.write('media/orphan-1.jpg', new Uint8Array([1]));
    w.files.setMtime('media/orphan-1.jpg', NOW - 2 * HOUR);
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    let release: () => void = () => undefined;
    const stack = w.make({ beforeLaunch: () => new Promise<void>((resolve) => (release = resolve)) });
    stack.start();
    await flush(600);
    expect(w.files.paths()).not.toContain('media/orphan-1.jpg');
    expect(w.pkg.requests).toEqual([]);
    release();
    await stack.settled();
    await stack.idle();
    expect(paths(w)).toContain('POST /api/inspections');
    await stack.stop();
  });

  it('a stored photo is not uploaded while the look is waiting, and goes once it ends', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set('/api/inspections/insp-1/media/upload-url', () =>
      jsonReply(200, { success: true, data: { url: '/api/public/uploads/photo?token=payload0001.signature0001', key: 'tenant-1/inspections/insp-1/photos/p1.jpg', expiresAt: 9_999_999_999_999 } }),
    );
    const seeding = createMediaStore({ db: w.replay.db, files: w.files, isBlocked: neverBlocked });
    await seeding.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    let release: () => void = () => undefined;
    const stack = w.make({ beforeLaunch: () => new Promise<void>((resolve) => (release = resolve)) });
    stack.start();
    await flush(800);
    expect(w.plugin.starts).toEqual([]);
    expect(paths(w).some((p) => p.endsWith('/media/upload-url'))).toBe(false);
    release();
    await stack.settled();
    await stack.idle();
    expect(paths(w).some((p) => p.endsWith('/media/upload-url'))).toBe(true);
    await stack.stop();
  });

  it('a stack stopped while the look is waiting starts nothing when the look ends', async () => {
    const w = await createStackWorld();
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    let release: () => void = () => undefined;
    const stack = w.make({ beforeLaunch: () => new Promise<void>((resolve) => (release = resolve)) });
    stack.start();
    await flush(600);
    await stack.stop();
    release();
    await flush(600);
    expect(w.pkg.requests).toEqual([]);
    expect(w.plugin.starts).toEqual([]);
    // Nothing was subscribed after the stop either: no listener, no timer is left behind.
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
  });
});
