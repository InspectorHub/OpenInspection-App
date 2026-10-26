import { describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createManualClock } from '../platform/clock';
import { MediaError } from './errors';
import { createNativeUploader, type NativeUploader } from './native-uploader';
import { createMediaReconciler, type MediaReconciler, type ResolvePending } from './reconcile';
import { combinedEngine, createFakeVideoEngine, videoRecord, type FakeVideoEngine } from './test-support/video-fakes';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN, photoRecord, type FakePlugin, type MediaWorld } from './test-support/fakes';
import { createVideoStrategy } from './video';

const SESSION_OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as const;
const OTHER = 'insp-2';

interface Setup {
  world: MediaWorld;
  video: FakeVideoEngine;
  plugin: FakePlugin;
  timers: ReturnType<typeof createManualTimers>;
  uploader: NativeUploader;
  rec: MediaReconciler;
  resolve: ReturnType<typeof vi.fn<ResolvePending>>;
  errors: unknown[];
  blocked: Set<string>;
}

async function setup(): Promise<Setup> {
  const world = await createMediaWorld();
  const video = createFakeVideoEngine('r2');
  const combined = combinedEngine(world.engine, video);
  const plugin = createFakePlugin({ engine: combined, files: world.files });
  const timers = createManualTimers();
  const clock = createManualClock(1_000_000);
  const errors: unknown[] = [];
  const blocked = new Set<string>();
  const isBlocked = (id: string): Promise<boolean> => Promise.resolve(blocked.has(id));
  const resolve = vi.fn<ResolvePending>(() => Promise.resolve('resolved'));
  const uploader = createNativeUploader({
    store: world.store,
    http: combined.http,
    tokens: { getAccessToken: () => Promise.resolve('access-token-secret'), checkSession: () => Promise.resolve(SESSION_OK) },
    plugin,
    origin: ORIGIN,
    isLocked: () => false,
    clientHeaders: { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' },
    timers,
    clock,
    random: () => 1,
    onError: (e) => errors.push(e),
    video: createVideoStrategy(),
    isBlocked,
  });
  const rec = createMediaReconciler({
    store: world.store,
    uploader,
    resolveDefectPhoto: () => Promise.resolve('missing'),
    resolvePending: resolve,
    resolveVideo: () => Promise.resolve('resolved'),
    isLocked: () => false,
    network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
    clock,
    timers,
    random: () => 0.5,
    onError: (e) => errors.push(e),
    isBlocked,
  });
  return { world, video, plugin, timers, uploader, rec, resolve, errors, blocked };
}

describe('cancelFor is scoped to one inspection', () => {
  it("cancelling A neither cancels nor waits for B's transfer, and B still completes afterwards", async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    await s.world.store.put(photoRecord('pa', { inspectionId: INSPECTION }));
    await s.world.store.put(photoRecord('pb', { inspectionId: OTHER }));
    const a = s.uploader.uploadDetailed({ pendingId: 'pa', inspectionId: INSPECTION });
    const b = s.uploader.uploadDetailed({ pendingId: 'pb', inspectionId: OTHER });
    await s.plugin.whenStarted(2);
    // Each transfer arms its timeout once it is registered: two timers mean both are waiting to be cancelled or finished.
    await vi.waitFor(() => {
      expect(s.timers.pending()).toBe(2);
    });
    // B's transfer is held for the whole call: a cancel that waited for it would never come back.
    await s.uploader.cancelFor(INSPECTION);
    expect(await a).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(s.plugin.removed).toHaveLength(1);
    expect(s.uploader.isActive('pb')).toBe(true);
    const survivor = s.plugin.heldIds().find((id) => !s.plugin.removed.includes(id));
    expect(survivor).toBeDefined();
    s.plugin.finish(survivor ?? '', 200);
    expect((await b).ok).toBe(true);
  });
});

describe('a transfer that finishes after the inspection was blocked does not run its finishing step', () => {
  it('a clip whose file arrived while a tombstone landed is not finalized; the row keeps its key for the resume', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.plugin.defaultBehavior = { kind: 'hang' };
    const done = s.uploader.uploadDetailed({ pendingId: 'v1', inspectionId: INSPECTION });
    await s.plugin.whenStarted(1);
    s.blocked.add(INSPECTION);
    s.plugin.finish(s.plugin.heldIds()[0] ?? '', 200);
    expect(await done).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(s.video.finalizes).toEqual([]);
    expect(s.errors).toEqual([]);
    const row = await s.world.store.getRow('v1');
    expect(row?.state).toBe('uploading');
    expect(row?.uploadedKey).not.toBeNull();
  });

  it('control: the same clip with nothing blocked is finalized', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.plugin.defaultBehavior = { kind: 'hang' };
    const done = s.uploader.uploadDetailed({ pendingId: 'v1', inspectionId: INSPECTION });
    await s.plugin.whenStarted(1);
    s.plugin.finish(s.plugin.heldIds()[0] ?? '', 200);
    expect((await done).ok).toBe(true);
    expect(s.video.finalizes).toHaveLength(1);
  });
});

describe('the media reconciler treats a BLOCKED document step as "leave untouched"', () => {
  async function uploadedPhoto(s: Setup): Promise<void> {
    await s.world.store.put(photoRecord('a1'));
    expect((await s.uploader.uploadDetailed({ pendingId: 'a1', inspectionId: INSPECTION })).ok).toBe(true);
  }

  it('a document step that answers BLOCKED reports nothing and keeps the row and its file', async () => {
    const s = await setup();
    await uploadedPhoto(s);
    s.resolve.mockRejectedValue(new MediaError('BLOCKED'));
    await s.rec.reconcileUploads();
    expect(s.resolve).toHaveBeenCalledTimes(1);
    expect(s.errors).toEqual([]);
    expect((await s.world.store.getRow('a1'))?.state).toBe('uploaded');
    expect(s.world.files.paths()).toContain('media/a1.jpg');
  });

  it('control: any other failure of the document step is reported, and the row and file are kept too', async () => {
    const s = await setup();
    await uploadedPhoto(s);
    s.resolve.mockRejectedValue(new Error('document unreadable'));
    await s.rec.reconcileUploads();
    expect(s.errors).toHaveLength(1);
    expect((await s.world.store.getRow('a1'))?.state).toBe('uploaded');
    expect(s.world.files.paths()).toContain('media/a1.jpg');
  });
});
