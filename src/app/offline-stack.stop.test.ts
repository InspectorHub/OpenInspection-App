import { describe, expect, it } from 'vitest';
import { photoRecord } from '../media/test-support/fakes';
import { deferred } from '../offline/test-support/replay-world';
import { jsonReply } from '../offline/test-support/package-world';
import { ALICE } from '../offline/test-support/replay-world';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

/** A failing run of these tests hangs on a transfer nobody will ever report; it is cut short here instead of after 30 s. */
const FAST = 3000;
const MINT = '/api/inspections/insp-1/media/upload-url';

function mintAnswers(w: StackWorld): void {
  w.pkg.overrides.set(MINT, () => jsonReply(200, { success: true, data: { url: '/api/public/uploads/photo?token=payload0001.signature0001', key: 'tenant-1/inspections/insp-1/photos/p1.jpg', expiresAt: 9_999_999_999_999 } }));
}

describe('stop() is terminal for the media path', () => {
  it('an upload waiting for its destination when the stack stops is not started afterwards, and its row stays pending', async () => {
    const w = await createStackWorld();
    mintAnswers(w);
    const stack = w.make();
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    const gate = deferred();
    const inFlight = deferred();
    w.pkg.hook = async (request) => {
      if (request.path === MINT) {
        inFlight.resolve();
        await gate.promise;
      }
    };
    const outcome = stack.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: 'insp-1' });
    await inFlight.promise;
    const stopping = stack.stop();
    gate.resolve();
    await stopping;
    await expect(outcome).resolves.toMatchObject({ ok: false, code: 'LOCKED', halt: true });
    expect(w.plugin.starts.length).toBe(0);
    expect((await stack.store.getRow('p1'))?.state).toBe('pending');
    expect(w.plugin.listenerCount()).toBe(0);
  }, FAST);

  it('an upload the plugin is already running when the stack stops is cancelled and its row goes back to what it was', async () => {
    const w = await createStackWorld();
    mintAnswers(w);
    w.plugin.defaultBehavior = { kind: 'hang' };
    const stack = w.make();
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    const outcome = stack.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: 'insp-1' });
    await w.plugin.whenStarted(1);
    expect((await stack.store.getRow('p1'))?.state).toBe('uploading');
    await stack.stop();
    await expect(outcome).resolves.toMatchObject({ ok: false, code: 'DISPOSED', halt: true });
    expect((await stack.store.getRow('p1'))?.state).toBe('pending');
    expect(w.plugin.removed.length).toBe(1);
    expect(w.plugin.listenerCount()).toBe(0);
  }, FAST);

  it('a media run that was already going when the stack stops starts nothing more', async () => {
    const w = await createStackWorld();
    mintAnswers(w);
    const stack = w.make();
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    const gate = deferred();
    const inFlight = deferred();
    w.pkg.hook = async (request) => {
      if (request.path === MINT) {
        inFlight.resolve();
        await gate.promise;
      }
    };
    stack.start();
    await inFlight.promise;
    const stopping = stack.stop();
    gate.resolve();
    await stopping;
    await stack.settled();
    await stack.idle();
    expect(w.plugin.starts.length).toBe(0);
    expect((await stack.store.getRow('p1'))?.state).toBe('pending');
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
  }, FAST);
});

describe('stop()', () => {
  it('returns the same promise however often it is called, and ends the same way', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    stack.start();
    await stack.settled();
    const first = stack.stop();
    const second = stack.stop();
    expect(second).toBe(first);
    await first;
    expect(stack.stop()).toBe(first);
    expect(stack.isStopped()).toBe(true);
  });

  it('forgets the plan of the latest reconcile decision', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set('/api/client/inspections/visible', () => jsonReply(200, { success: true, data: { visible: [] } }));
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id) VALUES (?, 1, 0, 1, ?, ?)', ['gone-1', ALICE.tenantId, ALICE.userId]);
    const stack = w.make();
    stack.start();
    await stack.settled();
    await stack.idle();
    expect(stack.lastPlan()).not.toBeNull();
    await stack.stop();
    expect(stack.lastPlan()).toBeNull();
  });
});
