import { describe, expect, it } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createNativeUploader } from '../media/native-uploader';
import { createMediaReconciler } from '../media/reconcile';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN } from '../media/test-support/fakes';
import { combinedEngine, createFakeVideoEngine } from '../media/test-support/video-fakes';
import { createVideoStrategy } from '../media/video';
import { createManualClock } from '../platform/clock';
import { neverBlocked } from '../test-support/never-blocked';
import { clip, need, SESSION_OK, setup } from './test-support/video-world';

describe('offline recording, then the connection returns', () => {
  it('the reconciler creates the upload, sends the clip, finalizes on the server, and only then resolves and deletes the local copy', async () => {
    const world = await createMediaWorld();
    const engine = createFakeVideoEngine('r2');
    const combined = combinedEngine(world.engine, engine);
    const plugin = createFakePlugin({ engine: combined, files: world.files });
    const timers = createManualTimers();
    const clock = createManualClock(1_000_000);
    const uploader = createNativeUploader({
      isBlocked: neverBlocked,
      store: world.store,
      http: combined.http,
      tokens: { getAccessToken: () => Promise.resolve('access-token'), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin,
      origin: ORIGIN,
      isLocked: () => false,
      clientHeaders: {},
      timers,
      clock,
      random: () => 1,
      video: createVideoStrategy(),
    });
    const s = await setup({ online: false, world });
    const order: string[] = [];
    const resolveVideo: typeof s.adapter.resolveVideo = async (inspectionId, pendingId, ref) => {
      order.push(`resolve:finalizes=${String(engine.finalizes.length)}`);
      return s.adapter.resolveVideo(inspectionId, pendingId, ref);
    };
    const reconciler = createMediaReconciler({
      isBlocked: neverBlocked,
      store: world.store,
      uploader,
      resolveDefectPhoto: () => Promise.resolve('missing'),
      resolvePending: () => Promise.resolve('resolved'),
      resolveVideo,
      isLocked: () => false,
      network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
      clock,
      timers,
      random: () => 0.5,
    });

    // Offline: the clip is recorded to the device and nothing reaches the server.
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, { itemId: 'i1' })).data);
    await s.adapter.video.uploadFile(ticket, clip(), () => undefined);
    expect(engine.creates).toEqual([]);
    expect(world.files.paths()).toHaveLength(1);

    // The connection returns.
    await expect(reconciler.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(engine.creates).toHaveLength(1);
    expect(engine.finalizes).toHaveLength(1);
    expect(engine.pool.size).toBe(1);
    expect(order).toEqual(['resolve:finalizes=1']);
    expect(await world.store.listRows()).toEqual([]);
    expect(world.files.paths()).toEqual([]);
  });

  it('control: with the old placeholder that always answers missing, the file stays on the device for good', async () => {
    const world = await createMediaWorld();
    const engine = createFakeVideoEngine('r2');
    const combined = combinedEngine(world.engine, engine);
    const plugin = createFakePlugin({ engine: combined, files: world.files });
    const timers = createManualTimers();
    const clock = createManualClock(1_000_000);
    const uploader = createNativeUploader({
      isBlocked: neverBlocked,
      store: world.store,
      http: combined.http,
      tokens: { getAccessToken: () => Promise.resolve('access-token'), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin,
      origin: ORIGIN,
      isLocked: () => false,
      clientHeaders: {},
      timers,
      clock,
      random: () => 1,
      video: createVideoStrategy(),
    });
    const s = await setup({ online: false, world });
    const reconciler = createMediaReconciler({
      isBlocked: neverBlocked,
      store: world.store,
      uploader,
      resolveDefectPhoto: () => Promise.resolve('missing'),
      resolvePending: () => Promise.resolve('resolved'),
      resolveVideo: () => Promise.resolve('missing'),
      isLocked: () => false,
      network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
      clock,
      timers,
      random: () => 0.5,
    });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    await s.adapter.video.uploadFile(ticket, clip(), () => undefined);
    await reconciler.reconcileUploads();
    expect(engine.finalizes).toHaveLength(1);
    expect(world.files.paths()).toHaveLength(1);
  });
});
