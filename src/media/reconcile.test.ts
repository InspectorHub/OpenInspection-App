import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../platform/clock';
import { AuthError } from '../auth/errors';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { fakeAppState } from '../offline/test-support/fakes';
import { createNativeUploader, MAX_UPLOAD_ATTEMPTS, transientBackoffMs, type NativeUploader } from './native-uploader';
import { createMediaReconciler, MIN_RETRY_DELAY_MS, type MediaReconciler, type ResolvePending } from './reconcile';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN, photoRecord, response, type FakePlugin, type MediaWorld } from './test-support/fakes';
import { neverBlocked } from '../test-support/never-blocked';

const SESSION_OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as const;

function fakeNetwork(initial = true) {
  let online = initial;
  const listeners = new Set<(online: boolean) => void>();
  return {
    online: () => Promise.resolve(online),
    onChange: (cb: (online: boolean) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next: boolean) {
      online = next;
      for (const l of [...listeners]) l(next);
    },
    setQuietly(next: boolean) {
      online = next;
    },
    listeners: () => listeners.size,
  };
}

interface Setup {
  world: MediaWorld;
  plugin: FakePlugin;
  timers: ReturnType<typeof createManualTimers>;
  clock: ReturnType<typeof createManualClock>;
  network: ReturnType<typeof fakeNetwork>;
  appState: ReturnType<typeof fakeAppState>;
  state: { locked: boolean; token: string | null };
  log: string[];
  resolve: ReturnType<typeof vi.fn<ResolvePending>>;
  errors: unknown[];
  uploader: NativeUploader;
  rec: ReturnType<typeof createMediaReconciler>;
}

async function setup(options: { concurrency?: number; maxRowsPerPass?: number; fallbackIntervalMs?: number; world?: MediaWorld; plugin?: FakePlugin; onUnlocked?: (cb: () => void) => () => void } = {}): Promise<Setup> {
  const world = options.world ?? (await createMediaWorld());
  const plugin = options.plugin ?? createFakePlugin({ engine: world.engine, files: world.files });
  const timers = createManualTimers();
  const clock = createManualClock(1_000_000);
  const network = fakeNetwork();
  const appState = fakeAppState();
  const state = { locked: false, token: 'access-token-secret' as string | null };
  const log: string[] = [];
  const errors: unknown[] = [];
  const originalDelete = world.store.delete.bind(world.store);
  world.store.delete = async (id) => {
    log.push(`delete:${id}`);
    await originalDelete(id);
  };
  const resolve = vi.fn<ResolvePending>((inspectionId, pendingId) => {
    log.push(`resolve:${pendingId}`);
    void inspectionId;
    return Promise.resolve('resolved');
  });
  const uploader = createNativeUploader({
    isBlocked: neverBlocked,
    store: world.store,
    http: world.engine.http,
    tokens: { getAccessToken: () => Promise.resolve(state.token), checkSession: () => Promise.resolve(SESSION_OK) },
    plugin,
    origin: ORIGIN,
    isLocked: () => state.locked,
    clientHeaders: {},
    timers,
    clock,
    random: () => 1,
    onRetry: () => {
      recRef?.trigger();
    },
  });
  let recRef: MediaReconciler | null = null;
  const rec = createMediaReconciler({
    isBlocked: neverBlocked,
    store: world.store,
    uploader,
    resolveDefectPhoto: () => Promise.resolve('missing'),
    resolvePending: resolve,
    isLocked: () => state.locked,
    network,
    appState,
    clock,
    timers,
    random: () => 0.5,
    ...(options.fallbackIntervalMs === undefined ? {} : { fallbackIntervalMs: options.fallbackIntervalMs }),
    ...(options.onUnlocked === undefined ? {} : { onUnlocked: options.onUnlocked }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.maxRowsPerPass === undefined ? {} : { maxRowsPerPass: options.maxRowsPerPass }),
    onError: (e) => errors.push(e),
  });
  recRef = rec;
  return { world, plugin, timers, clock, network, appState, state, log, resolve, errors, uploader, rec };
}

/** Lets every chain of already-resolved promises run to its end: the fakes in these tests never wait on a timer. */
function quiet(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function putPhotos(s: Setup, ids: string[]): Promise<void> {
  let at = 1;
  for (const id of ids) await s.world.store.put(photoRecord(id, { createdAt: at++ }));
}

describe('reconcile: uploading, resolving, deleting', () => {
  it('uploads every pending photo, resolves it in the document, then deletes the file and the row', async () => {
    const s = await setup();
    await putPhotos(s, ['p1', 'p2', 'p3', 'p4', 'p5']);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 5 });
    expect(s.world.engine.objects.size).toBe(5);
    expect(s.world.files.paths()).toEqual([]);
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.resolve).toHaveBeenCalledTimes(5);
    expect(s.resolve).toHaveBeenCalledWith(INSPECTION, 'p1', `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      expect(s.log.indexOf(`resolve:${id}`), id).toBeGreaterThanOrEqual(0);
      expect(s.log.indexOf(`resolve:${id}`), id).toBeLessThan(s.log.indexOf(`delete:${id}`));
    }
  });

  it('keeps the file and the row when the document cannot be updated, and retries only the resolve (no second upload)', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.resolve.mockRejectedValueOnce(new Error('doc is busy'));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.world.files.paths()).toEqual(['media/p1.jpg']);
    expect(s.log.filter((l) => l.startsWith('delete'))).toEqual([]);
    const row = await s.world.store.getRow('p1');
    expect(row).toMatchObject({ state: 'uploaded', uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/p1.jpg` });
    expect(s.plugin.starts).toHaveLength(1);

    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.world.engine.objects.size).toBe(1);
    expect(s.world.files.paths()).toEqual([]);
    expect(s.resolve).toHaveBeenCalledTimes(2);
  });

  it('a document that has no such pending entry yet ("missing") keeps the file, as the entry may not have been written', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.resolve.mockResolvedValueOnce('missing');
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.world.files.paths()).toEqual(['media/p1.jpg']);
    s.resolve.mockResolvedValueOnce('already');
    s.clock.advance(60_000);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.world.files.paths()).toEqual([]);
  });

  it('a failure to delete after a successful resolve is retried on the next pass without uploading or failing the loop', async () => {
    const s = await setup();
    await putPhotos(s, ['p1', 'p2']);
    s.world.files.failRemoveFor('media/p1.jpg');
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'uploaded' });
    expect(s.errors).toHaveLength(1);
  });
});

describe('reconcile: after a restart (Review Focus 1)', () => {
  it('re-starts a row left in "uploading" and ends uploaded with exactly one server object', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('p1'));
    await world.store.put(photoRecord('p2'));

    // Process one: both uploads start, the server may even receive them, and then the process is killed.
    const first = createFakePlugin({ engine: world.engine, files: world.files, idPrefix: 'dead' });
    first.defaultBehavior = { kind: 'hang' };
    const s1 = await setup({ world, plugin: first });
    void s1.rec.reconcileUploads();
    await first.whenStarted(2);
    expect((await world.store.listRows()).map((r) => r.state)).toEqual(['uploading', 'uploading']);
    // The server did get p1's bytes before the kill; the app never heard back.
    world.engine.receive(first.starts[0]?.serverUrl ?? '', world.files.bytes('media/p1.jpg') ?? new Uint8Array());
    expect(world.engine.objects.size).toBe(1);

    // Process two: a fresh plugin that knows nothing about the old uploads.
    const second = createFakePlugin({ engine: world.engine, files: world.files, idPrefix: 'new' });
    const s2 = await setup({ world, plugin: second });
    await expect(s2.rec.reconcileUploads()).resolves.toEqual({ retried: 2, confirmed: 2 });
    expect(second.starts).toHaveLength(2);
    expect(world.engine.objects.size).toBe(2);
    expect([...world.engine.objects.keys()].sort()).toEqual([
      `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`,
      `tenant-1/inspections/${INSPECTION}/photos/p2.jpg`,
    ]);
    expect(await world.store.listRows()).toEqual([]);
    expect(world.files.paths()).toEqual([]);
  });

  it('restarts after the old process reported success nobody saw: the repeat overwrites, one object', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('p1'));
    await world.store.markState('p1', 'uploading', { attempts: 1 });
    const key = `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`;
    world.engine.objects.set(key, new Uint8Array([1, 2, 3]));
    const s = await setup({ world });
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 1, confirmed: 1 });
    expect(world.engine.objects.size).toBe(1);
    expect(world.engine.objects.get(key)?.length).toBe(64);
  });

  it('a row stuck in "uploading" that has used all its attempts is given up (failed), not restarted forever', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    await s.world.store.markState('p1', 'uploading', { attempts: MAX_UPLOAD_ATTEMPTS });
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.plugin.starts).toHaveLength(0);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
  });

  it('does not restart a row whose upload is still running in this process', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.plugin.defaultBehavior = { kind: 'hang' };
    const running = s.rec.reconcileUploads();
    await s.plugin.whenStarted(1);
    // A foreground event (or any caller) asks again while the first pass is still waiting on the plugin.
    const again = s.rec.reconcileUploads();
    expect(again).toBe(running);
    expect(s.plugin.starts).toHaveLength(1);
    s.plugin.finish('up-1');
    await running;
    expect(s.plugin.starts).toHaveLength(1);
  });
});

describe('reconcile: concurrency, single flight, bounds', () => {
  it('runs at most three uploads at a time, and does reach three', async () => {
    const s = await setup();
    await putPhotos(s, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    s.plugin.defaultBehavior = { kind: 'hang' };
    const done = s.rec.reconcileUploads();
    await s.plugin.whenStarted(3);
    await quiet();
    // Everything but a fourth start has had its chance by now: the fakes only use microtasks.
    expect(s.plugin.starts).toHaveLength(3);
    expect(s.plugin.inFlight()).toBe(3);
    for (let finished = 0; finished < 7; finished += 1) {
      const id = s.plugin.heldIds()[0];
      if (id === undefined) throw new Error('nothing is held although photos remain');
      s.plugin.finish(id);
      await quiet();
      expect(s.plugin.inFlight()).toBeLessThanOrEqual(3);
    }
    await expect(done).resolves.toEqual({ retried: 0, confirmed: 7 });
    expect(s.plugin.maxInFlight()).toBe(3);
    expect(s.plugin.starts).toHaveLength(7);
  });

  it('coalesces concurrent calls into one pass', async () => {
    const s = await setup();
    await putPhotos(s, ['a', 'b']);
    const [x, y, z] = await Promise.all([s.rec.reconcileUploads(), s.rec.reconcileUploads(), s.rec.reconcileUploads()]);
    expect(x).toEqual({ retried: 0, confirmed: 2 });
    expect(y).toEqual(x);
    expect(z).toEqual(x);
    expect(s.plugin.starts).toHaveLength(2);
    expect(s.world.engine.http.calls).toHaveLength(2);
  });

  it('a call made after the pass finished starts a new pass', async () => {
    const s = await setup();
    await putPhotos(s, ['a']);
    await s.rec.reconcileUploads();
    await putPhotos(s, ['b']);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
  });

  it('reads the table in bounded pages and still gets through a list larger than one page', async () => {
    const s = await setup({ maxRowsPerPass: 4 });
    const limits: (number | undefined)[] = [];
    const original = s.world.store.listRowsPage.bind(s.world.store);
    s.world.store.listRowsPage = (filter) => {
      limits.push(filter?.limit);
      return original(filter);
    };
    await putPhotos(s, Array.from({ length: 11 }, (_, i) => `p${String(i).padStart(2, '0')}`));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 11 });
    expect(limits.length).toBeGreaterThan(1);
    expect(limits.every((l) => l !== undefined && l <= 4)).toBe(true);
  });

  it('skips corrupt rows (unknown state, bad path) without throwing and still uploads the good ones', async () => {
    const s = await setup();
    await putPhotos(s, ['good-1', 'good-2']);
    const meta = JSON.stringify({ targetType: 'item', findingKey: 'k', itemId: 'i' });
    const insert = 'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)';
    await s.world.db.run(insert, ['bad-state', INSPECTION, 'photo', 'media/bad-state.jpg', 'image/jpeg', meta, 'exploded', 0, 0]);
    await s.world.db.run(insert, ['bad-path', INSPECTION, 'photo', '../../etc/passwd', 'image/jpeg', meta, 'pending', 0, 0]);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 2 });
    expect(s.plugin.starts).toHaveLength(2);
    expect(s.world.files.accessed().every((p) => /^media\/[A-Za-z0-9_-]{1,64}\.(jpg|png|heic)$/.test(p))).toBe(true);
    expect(s.world.files.accessed()).not.toContain('../../etc/passwd');
  });

  it('one row throwing from the store does not stop the others', async () => {
    const s = await setup();
    await putPhotos(s, ['a', 'b', 'c']);
    const original = s.world.store.getRow.bind(s.world.store);
    s.world.store.getRow = (id) => (id === 'b' ? Promise.reject(new Error('boom')) : original(id));
    const result = await s.rec.reconcileUploads();
    expect(result.confirmed).toBe(2);
  });

  it('ignores rows of kinds it cannot upload yet and leaves them untouched', async () => {
    const s = await setup();
    await s.world.store.put({
      pendingId: 'crop-1', inspectionId: INSPECTION, kind: 'crop', blob: photoRecord('x').blob, createdAt: 1,
      meta: { findingKey: 'k', itemId: 'i', photoIndex: 0, photoKey: 'pk', crop: {} as never },
    });
    await putPhotos(s, ['p1']);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(await s.world.store.getRow('crop-1')).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe('reconcile: retries, backoff, giving up', () => {
  it('retries a failed row with exponential backoff and a timer for each next try, and never gives up on a transient failure (I-3)', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.world.engine.mintOverride = () => response(503);
    s.rec.start();
    await s.rec.idle();
    let previous = 0;
    for (let attempt = 1; attempt <= 14; attempt += 1) {
      const row = await s.world.store.getRow('p1');
      expect(row).toMatchObject({ state: 'failed', attempts: attempt });
      const expected = transientBackoffMs(attempt, null, () => 1);
      expect(s.timers.delays()).toEqual([expected]);
      expect(expected).toBeGreaterThanOrEqual(previous);
      previous = expected;
      s.clock.advance(expected);
      s.timers.fireNext();
      await s.rec.idle();
    }
    expect(previous).toBe(3_600_000);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'failed', attempts: 15 });
    expect(s.timers.pending()).toBe(1);
    s.world.engine.mintOverride = null;
    s.clock.advance(3_600_000);
    s.timers.fireNext();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
  });

  it('a row that failed is not retried before its backoff has passed, even if another pass runs', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.world.engine.mintOverride = () => response(500);
    await s.rec.reconcileUploads();
    const calls = s.world.engine.http.calls.length;
    await s.rec.reconcileUploads();
    expect(s.world.engine.http.calls.length).toBe(calls);
    s.clock.advance(15_000);
    s.world.engine.mintOverride = null;
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 1, confirmed: 1 });
  });

  it('honours a Retry-After from the server for the next try, clamped to five minutes', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.world.engine.mintOverride = () => response(429, undefined, { retryAfterMs: 45_000 });
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.delays()).toEqual([45_000]);
    s.world.engine.mintOverride = () => response(429, undefined, { retryAfterMs: 3_600_000 });
    s.clock.advance(45_000);
    s.timers.fireNext();
    await s.rec.idle();
    expect(s.timers.delays()).toEqual([300_000]);
    s.rec.stop();
    expect(s.timers.pending()).toBe(0);
  });

  it('a permanently rejected photo (413) stays failed and visible, and is not retried', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: 413 };
    await s.rec.reconcileUploads();
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    expect(s.world.files.paths()).toEqual(['media/p1.jpg']);
    await s.rec.reconcileUploads();
    expect(s.plugin.starts).toHaveLength(1);
  });

  it('after a restart a failed row below the cap is retried immediately and counted as a retry', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    await s.world.store.markState('p1', 'failed', { attempts: 3 });
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 1, confirmed: 1 });
  });
});

describe('reconcile: never while locked, revoked, signed out or offline', () => {
  it('a locked device (revoked devices report as locked too) makes no network call and touches no row', async () => {
    const s = await setup();
    await putPhotos(s, ['p1', 'p2']);
    s.state.locked = true;
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(s.plugin.starts).toHaveLength(0);
    expect((await s.world.store.listRows()).map((r) => [r.state, r.attempts])).toEqual([['pending', 0], ['pending', 0]]);
    // Control: once the lock is gone the same rows upload.
    s.state.locked = false;
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 2 });
  });

  it('a lock check that throws counts as locked', async () => {
    const world = await createMediaWorld();
    const s = await setup({ world });
    await putPhotos(s, ['p1']);
    const throwing = createMediaReconciler({
      isBlocked: neverBlocked,
      store: world.store, uploader: createNativeUploader({
        isBlocked: neverBlocked,
        store: world.store, http: world.engine.http, tokens: { getAccessToken: () => Promise.resolve('t'), checkSession: () => Promise.resolve(SESSION_OK) },
        plugin: s.plugin, origin: ORIGIN, isLocked: () => { throw new Error('storage'); }, clientHeaders: {}, timers: s.timers,
      }),
      resolveDefectPhoto: () => Promise.resolve('missing'), resolvePending: s.resolve, isLocked: () => { throw new Error('storage'); }, network: s.network, clock: s.clock, timers: s.timers,
    });
    await expect(throwing.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.plugin.starts).toHaveLength(0);
  });

  it('offline: nothing is sent and rows are untouched; online again: they go', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.network.setQuietly(false);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.world.engine.http.calls).toHaveLength(0);
    s.network.setQuietly(true);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
  });

  it('signing out in the middle of a run starts no further upload', async () => {
    const s = await setup({ concurrency: 1 });
    await putPhotos(s, ['p1', 'p2', 'p3']);
    s.resolve.mockImplementation((_i, pendingId) => {
      s.log.push(`resolve:${pendingId}`);
      s.state.token = null;
      return Promise.resolve('resolved');
    });
    const result = await s.rec.reconcileUploads();
    expect(result).toEqual({ retried: 0, confirmed: 1 });
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.world.engine.http.calls).toHaveLength(1);
    expect((await s.world.store.listRows()).map((r) => [r.pendingId, r.state, r.attempts])).toEqual([['p2', 'pending', 0], ['p3', 'pending', 0]]);
  });

  it('locking in the middle of a run starts no further upload', async () => {
    const s = await setup({ concurrency: 1 });
    await putPhotos(s, ['p1', 'p2', 'p3']);
    s.resolve.mockImplementation((_i, pendingId) => {
      s.log.push(`resolve:${pendingId}`);
      s.state.locked = true;
      return Promise.resolve('resolved');
    });
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.plugin.starts).toHaveLength(1);
  });

  it('stop() ends the run: nothing starts after it', async () => {
    const s = await setup({ concurrency: 1 });
    await putPhotos(s, ['p1', 'p2']);
    s.resolve.mockImplementation((_i, pendingId) => {
      s.log.push(`resolve:${pendingId}`);
      s.rec.stop();
      return Promise.resolve('resolved');
    });
    await s.rec.reconcileUploads();
    expect(s.plugin.starts).toHaveLength(1);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
  });
});

describe('reconcile: triggers', () => {
  it('runs at start, when the network comes back and on returning to the foreground; not on going offline or to the background', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.rec.start();
    await s.rec.idle();
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.network.listeners()).toBe(1);
    expect(s.appState.listeners()).toBe(1);

    await putPhotos(s, ['p2']);
    s.network.set(false);
    s.appState.emit(false);
    await s.rec.idle();
    expect(s.plugin.starts).toHaveLength(1);

    s.network.set(true);
    await s.rec.idle();
    expect(s.plugin.starts).toHaveLength(2);

    await putPhotos(s, ['p3']);
    s.appState.emit(true);
    await s.rec.idle();
    expect(s.plugin.starts).toHaveLength(3);

    s.rec.stop();
    expect(s.network.listeners()).toBe(0);
    expect(s.appState.listeners()).toBe(0);
    await putPhotos(s, ['p4']);
    s.network.set(true);
    s.appState.emit(true);
    await s.rec.idle();
    expect(s.plugin.starts).toHaveLength(3);
  });

  it('attaches the plugin listener when it starts, so events replayed by the plugin are acknowledged', async () => {
    const s = await setup();
    s.rec.start();
    await s.rec.idle();
    expect(s.plugin.listenerCount()).toBe(1);
    s.plugin.emit({ name: 'completed', id: 'stale', eventId: 'old-1', payload: { statusCode: 200 } });
    expect(s.plugin.acks).toEqual(['old-1']);
    s.rec.stop();
  });

  it('a trigger that arrives while a pass is running makes one more pass afterwards, so rows added meanwhile are not missed', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.plugin.defaultBehavior = { kind: 'hang' };
    s.rec.start();
    await s.plugin.whenStarted(1);
    await putPhotos(s, ['p2']);
    s.network.set(true);
    s.plugin.defaultBehavior = { kind: 'complete' };
    s.plugin.finish('up-1');
    await s.rec.idle();
    expect(s.plugin.starts).toHaveLength(2);
    expect(await s.world.store.listRows()).toEqual([]);
    s.rec.stop();
  });
});

/** Fires the pending retry timer, then lets the run it starts finish; stops after `limit` fires so a spin cannot hang the test. */
async function fireRetryTimers(s: Setup, limit: number): Promise<number> {
  let fires = 0;
  while (s.timers.pending() > 0 && fires < limit) {
    s.timers.fireNext();
    fires += 1;
    await s.rec.idle();
  }
  return fires;
}

describe('reconcile: the retry timer never spins (M-1)', () => {
  async function failedOnce(s: Setup): Promise<number> {
    await putPhotos(s, ['p1']);
    s.world.engine.mintOverride = () => response(503);
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.requested()).toHaveLength(1);
    const due = s.timers.requested()[0] ?? 0;
    s.clock.advance(due + 1);
    return due;
  }

  it('goes offline before the timer fires: the fire arms only the slow fallback, one timer per fire, and the network coming back resumes the upload', async () => {
    const s = await setup();
    await failedOnce(s);
    s.network.setQuietly(false);
    s.timers.fireNext();
    await s.rec.idle();
    expect(s.timers.pending()).toBe(1);
    expect(s.timers.delays()).toEqual([300_000]);
    s.timers.fireNext();
    await s.rec.idle();
    expect(s.timers.delays()).toEqual([300_000]);
    expect(s.timers.requested().every((ms) => ms >= MIN_RETRY_DELAY_MS)).toBe(true);
    // Control: the network trigger resumes it.
    s.world.engine.mintOverride = null;
    s.network.set(true);
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.world.engine.objects.size).toBe(1);
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
  });

  it('locks before the timer fires: the fire arms only the slow fallback, and the unlock signal resumes the upload', async () => {
    const unlocked = new Set<() => void>();
    const s = await setup({ onUnlocked: (cb) => { unlocked.add(cb); return () => unlocked.delete(cb); } });
    await failedOnce(s);
    s.state.locked = true;
    s.timers.fireNext();
    await s.rec.idle();
    expect(s.timers.delays()).toEqual([300_000]);
    // Control: unlocking resumes it.
    s.state.locked = false;
    s.world.engine.mintOverride = null;
    for (const cb of [...unlocked]) cb();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
    expect(unlocked.size).toBe(0);
  });

  it('a photo deleted while it waits in backoff leaves no stale entry to re-arm the timer', async () => {
    const s = await setup();
    await failedOnce(s);
    await s.world.store.delete('p1');
    const fires = await fireRetryTimers(s, 25);
    expect(fires).toBe(1);
    expect(s.timers.pending()).toBe(0);
    expect(s.timers.requested()).toHaveLength(1);
    s.rec.stop();
  });

  it('still arms exactly one timer for a retry that is genuinely in the future (positive control)', async () => {
    const s = await setup();
    await putPhotos(s, ['p1', 'p2']);
    s.world.engine.mintOverride = () => response(503);
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.pending()).toBe(1);
    expect(s.timers.delays()[0]).toBeGreaterThan(0);
    s.rec.stop();
  });
});

describe('reconcile: a document without the entry is re-checked with a growing wait, never deleted (I-3)', () => {
  const MINUTE = 60_000;

  it('keeps the file and the row, asks the document again only after 1 min, 2 min, 4 min ... up to an hour', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.resolve.mockResolvedValue('missing');
    await s.rec.reconcileUploads();
    expect(s.resolve).toHaveBeenCalledTimes(1);
    expect(s.timers.delays()).toEqual([MINUTE]);

    let calls = 1;
    for (let miss = 1; miss <= 9; miss += 1) {
      const wait = Math.min(MINUTE * 2 ** (miss - 1), 3_600_000);
      s.clock.advance(wait - 1);
      await s.rec.reconcileUploads();
      expect(s.resolve, `just before ${String(wait)}`).toHaveBeenCalledTimes(calls);
      s.clock.advance(1);
      await s.rec.reconcileUploads();
      calls += 1;
      expect(s.resolve, `at ${String(wait)}`).toHaveBeenCalledTimes(calls);
      expect(s.timers.delays()).toEqual([Math.min(MINUTE * 2 ** miss, 3_600_000)]);
    }
    expect(s.world.files.paths()).toEqual(['media/p1.jpg']);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'uploaded' });
    expect(s.plugin.starts).toHaveLength(1);
    s.rec.stop();
  });

  it('counts the photos nobody references, and the count falls once the document has the entry', async () => {
    const s = await setup();
    await putPhotos(s, ['p1', 'p2']);
    s.resolve.mockResolvedValue('missing');
    expect(s.rec.countUnreferenced()).toBe(0);
    await s.rec.reconcileUploads();
    expect(s.rec.countUnreferenced()).toBe(2);
    s.resolve.mockResolvedValue('already');
    s.clock.advance(MINUTE);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 2 });
    expect(s.rec.countUnreferenced()).toBe(0);
    expect(s.world.files.paths()).toEqual([]);
  });

  it('a photo deleted from the store leaves the count and the wait behind', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.resolve.mockResolvedValue('missing');
    await s.rec.reconcileUploads();
    expect(s.rec.countUnreferenced()).toBe(1);
    await s.world.store.delete('p1');
    s.clock.advance(MINUTE);
    await s.rec.reconcileUploads();
    expect(s.rec.countUnreferenced()).toBe(0);
    expect(s.resolve).toHaveBeenCalledTimes(1);
  });

  it('recheckMissing() forgets the wait and runs now', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.resolve.mockResolvedValueOnce('missing');
    await s.rec.reconcileUploads();
    expect(s.resolve).toHaveBeenCalledTimes(1);
    s.resolve.mockResolvedValue('resolved');
    s.rec.recheckMissing();
    await s.rec.idle();
    expect(s.resolve).toHaveBeenCalledTimes(2);
    expect(await s.world.store.getRow('p1')).toBeNull();
    expect(s.rec.countUnreferenced()).toBe(0);
  });
});

describe('reconcile: paging goes by the rows the query returned (b)', () => {
  it('two corrupt rows ahead of the good ones do not end the paging when a page holds two rows', async () => {
    const s = await setup({ maxRowsPerPass: 2 });
    const meta = JSON.stringify({ targetType: 'item', findingKey: 'k', itemId: 'i' });
    const insert = 'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)';
    await s.world.db.run(insert, ['bad-state', INSPECTION, 'photo', 'media/bad-state.jpg', 'image/jpeg', meta, 'exploded', 0, 1]);
    await s.world.db.run(insert, ['bad-path', INSPECTION, 'photo', '../../etc/passwd', 'image/jpeg', meta, 'pending', 0, 2]);
    await s.world.store.put(photoRecord('good-1', { createdAt: 3 }));
    await s.world.store.put(photoRecord('good-2', { createdAt: 4 }));
    await s.world.store.put(photoRecord('good-3', { createdAt: 5 }));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 3 });
  });
});

describe('reconcile: a stored key that is not the photo\'s own is never put into a document (d)', () => {
  it('re-uploads the photo and resolves only the key the server minted for it', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    await s.world.store.markState('p1', 'uploaded', { attempts: 0, uploadedKey: 'other-tenant/inspections/other/photos/stolen.jpg' });
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 1, confirmed: 1 });
    expect(s.resolve).toHaveBeenCalledTimes(1);
    expect(s.resolve).toHaveBeenCalledWith(INSPECTION, 'p1', `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`);
    expect(s.resolve).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'other-tenant/inspections/other/photos/stolen.jpg');
  });
});

describe('reconcile: failures before the transfer keep backing off and never spin (I-6, I-3)', () => {
  it('a mint that keeps failing with a network error backs off to one hour and keeps exactly one timer armed', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.world.engine.mintOverride = () => {
      throw new AuthError('server_unreachable');
    };
    s.rec.start();
    await s.rec.idle();
    let fires = 0;
    let previous = 0;
    while (fires < 25) {
      expect(s.timers.pending()).toBe(1);
      const delay = s.timers.delays()[0] ?? 0;
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(3_600_000);
      previous = delay;
      s.clock.advance(delay);
      s.timers.fireNext();
      fires += 1;
      await s.rec.idle();
    }
    expect(previous).toBe(3_600_000);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'failed', attempts: 26 });
    expect(s.world.engine.http.calls).toHaveLength(26);
    expect(s.timers.requested()).toHaveLength(26);
    s.rec.stop();
    expect(s.timers.pending()).toBe(0);
  });
});

describe('reconcile: a slow fallback resumes a run that was cut short, and never spins (I-1)', () => {
  const FALLBACK = 300_000;

  it('signed out: the run is halted, the fallback is armed, and after sign-in it resumes with no other trigger', async () => {
    const s = await setup();
    await putPhotos(s, ['p1', 'p2']);
    s.state.token = null;
    s.rec.start();
    await s.rec.idle();
    expect(s.plugin.starts).toHaveLength(0);
    expect(s.timers.delays()).toEqual([FALLBACK]);
    s.state.token = 'access-token-secret';
    s.timers.fireNext();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.world.engine.objects.size).toBe(2);
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
  });

  it('client too old (426): the fallback is armed and resumes once the server accepts the client again', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.world.engine.mintOverride = () => response(426);
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.delays()).toEqual([FALLBACK]);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'pending', attempts: 0 });
    s.world.engine.mintOverride = null;
    s.timers.fireNext();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
  });

  it('locked with no unlock signal wired: the fallback resumes the run after unlock', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.state.locked = true;
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.delays()).toEqual([FALLBACK]);
    s.state.locked = false;
    s.timers.fireNext();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
  });

  it('trigger() is the call to make right after sign-in: it resumes at once and takes the fallback timer away', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.state.token = null;
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.pending()).toBe(1);
    s.state.token = 'access-token-secret';
    s.rec.trigger();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
  });

  it('nothing outstanding: no fallback is armed (empty table, everything confirmed, only permanent failures)', async () => {
    const s = await setup();
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.requested()).toEqual([]);
    await putPhotos(s, ['p1']);
    s.rec.trigger();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.timers.pending()).toBe(0);
    await putPhotos(s, ['gone']);
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: 413 };
    s.rec.trigger();
    await s.rec.idle();
    expect(await s.world.store.getRow('gone')).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
  });

  it('is armed only while the reconciler is started: a direct pass that was cut short arms nothing', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.state.token = null;
    await s.rec.reconcileUploads();
    expect(s.timers.requested()).toEqual([]);
  });

  it('stop() clears it, and a run that ends after stop() arms nothing', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.state.token = null;
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.pending()).toBe(1);
    s.rec.stop();
    expect(s.timers.pending()).toBe(0);
    s.rec.trigger();
    await s.rec.idle();
    expect(s.timers.pending()).toBe(0);
  });

  it('never a busy loop: fifty fires while still halted arm exactly one timer each, every delay at the fallback interval', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.state.token = null;
    s.rec.start();
    await s.rec.idle();
    for (let i = 0; i < 50; i += 1) {
      expect(s.timers.pending()).toBe(1);
      s.timers.fireNext();
      await s.rec.idle();
    }
    expect(s.timers.pending()).toBe(1);
    expect(s.timers.requested()).toHaveLength(51);
    expect(s.timers.requested().every((ms) => ms === FALLBACK)).toBe(true);
    expect(s.plugin.starts).toHaveLength(0);
    s.rec.stop();
  });

  it('the interval has a floor of one second and is clamped to a day', async () => {
    const tiny = await setup({ fallbackIntervalMs: 5 });
    await putPhotos(tiny, ['p1']);
    tiny.state.token = null;
    tiny.rec.start();
    await tiny.rec.idle();
    expect(tiny.timers.delays()).toEqual([MIN_RETRY_DELAY_MS]);
    tiny.rec.stop();

    const huge = await setup({ fallbackIntervalMs: 1e15 });
    await putPhotos(huge, ['p1']);
    huge.state.token = null;
    huge.rec.start();
    await huge.rec.idle();
    expect(huge.timers.delays()).toEqual([86_400_000]);
    huge.rec.stop();
  });
});

/** A reconciler over a scripted uploader, to reach states the real uploader never produces on demand. */
async function scripted(options: {
  rows: number;
  retryAt?: (pendingId: string, now: number) => number | null;
  outcome?: (pendingId: string) => Awaited<ReturnType<NativeUploader['uploadDetailed']>>;
  attemptsFail?: boolean;
  maxRowsPerPass?: number;
  concurrency?: number;
  start?: boolean;
  fallbackIntervalMs?: number;
  random?: () => number;
}) {
  const world = await createMediaWorld();
  const timers = createManualTimers();
  const clock = createManualClock(1_000_000);
  for (let i = 0; i < options.rows; i += 1) await world.store.put(photoRecord(`p${String(i + 1)}`, { createdAt: i + 1 }));
  const errors: unknown[] = [];
  const rec = createMediaReconciler({
    isBlocked: neverBlocked,
    store: world.store,
    uploader: {
      uploadDetailed: (ref) =>
        Promise.resolve(options.outcome ? options.outcome(ref.pendingId) : { ok: false, code: 'REJECTED', retryable: false, retryAfterMs: null, halt: false }),
      attach: () => (options.attemptsFail ? Promise.reject(new Error('plugin not ready')) : Promise.resolve()),
      isActive: () => false,
      retryAt: (id) => options.retryAt?.(id, clock.now()) ?? null,
      forgetExcept: () => undefined,
      handlesVideo: () => false,
    },
    resolveDefectPhoto: () => Promise.resolve('missing'),
    resolvePending: () => Promise.resolve('resolved'),
    isLocked: () => false,
    network: fakeNetwork(),
    clock,
    timers,
    random: options.random ?? (() => 0.5),
    ...(options.maxRowsPerPass === undefined ? {} : { maxRowsPerPass: options.maxRowsPerPass }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.fallbackIntervalMs === undefined ? {} : { fallbackIntervalMs: options.fallbackIntervalMs }),
    onError: (e) => errors.push(e),
  });
  if (options.start !== false) rec.start();
  await rec.idle();
  return { world, timers, clock, rec, errors };
}

const HALT = { ok: false, code: 'AUTH', retryable: true, retryAfterMs: null, halt: true } as const;
const SOFT = { ok: false, code: 'NETWORK', retryable: true, retryAfterMs: null, halt: false } as const;

describe('reconcile: the timer delay is bounded on both sides (a1, d)', () => {
  it('a wake 10 ms away still arms a one second timer, never a zero-delay one', async () => {
    const s = await scripted({ rows: 1, retryAt: (_id, now) => now + 10 });
    expect(s.timers.delays()).toEqual([MIN_RETRY_DELAY_MS]);
    s.rec.stop();
  });

  it('a wake ten days away (a wall clock that jumped back) is armed at one day, below the timer limit', async () => {
    const s = await scripted({ rows: 1, retryAt: (_id, now) => now + 10 * 86_400_000 });
    expect(s.timers.delays()).toEqual([86_400_000]);
    s.rec.stop();
    const far = await scripted({ rows: 1, retryAt: (_id, now) => now + 2 ** 31 + 5 });
    expect(far.timers.delays()).toEqual([86_400_000]);
    far.rec.stop();
  });
});

describe('reconcile: the fallback is jittered (I-1)', () => {
  it('between 75% and 125% of the interval, from the injected random source', async () => {
    const low = await scripted({ rows: 1, outcome: () => HALT, random: () => 0 });
    expect(low.timers.delays()).toEqual([225_000]);
    low.rec.stop();
    const high = await scripted({ rows: 1, outcome: () => HALT, random: () => 1 });
    expect(high.timers.delays()).toEqual([375_000]);
    high.rec.stop();
  });
});

describe('reconcile: a cut-short run ignores the wakes of other rows (a2)', () => {
  const outcome = (id: string) => (id === 'p2' ? HALT : ({ ok: true, key: `tenant-1/inspections/insp-1/photos/${id}.jpg`, reused: false } as const));

  it('p1 waits 20 s, p2 halts the run: without start nothing is armed; started, the only timer is the fallback, not the 20 s wake', async () => {
    const direct = await scripted({ rows: 2, concurrency: 1, start: false, retryAt: (id, now) => (id === 'p1' ? now + 20_000 : null), outcome });
    await direct.rec.reconcileUploads();
    expect(direct.timers.requested()).toEqual([]);
    const started = await scripted({ rows: 2, concurrency: 1, retryAt: (id, now) => (id === 'p1' ? now + 20_000 : null), outcome });
    expect(started.timers.delays()).toEqual([300_000]);
    started.rec.stop();
  });
});

describe('reconcile: a scan that failed or did not finish still arms the fallback (b)', () => {
  it('attach() throwing', async () => {
    const s = await scripted({ rows: 1, attemptsFail: true });
    expect(s.errors).toHaveLength(1);
    expect(s.timers.delays()).toEqual([300_000]);
    s.rec.stop();
  });

  it('the first page of the table failing to load', async () => {
    const world = await createMediaWorld();
    world.store.listRowsPage = () => Promise.reject(new Error('database is locked'));
    const timers = createManualTimers();
    const rec = createMediaReconciler({
      isBlocked: neverBlocked,
      store: world.store,
      uploader: { uploadDetailed: () => Promise.resolve(SOFT), attach: () => Promise.resolve(), isActive: () => false, retryAt: () => null, forgetExcept: () => undefined, handlesVideo: () => false },
      resolveDefectPhoto: () => Promise.resolve('missing'),
      resolvePending: () => Promise.resolve('resolved'),
      isLocked: () => false,
      network: fakeNetwork(),
      clock: createManualClock(1_000_000),
      timers,
      random: () => 0.5,
    });
    rec.start();
    await rec.idle();
    expect(timers.delays()).toEqual([300_000]);
    rec.stop();
    expect(timers.pending()).toBe(0);
  });

  it('the page limit being used up before the end of the table, with no row waiting for a wake', async () => {
    const s = await scripted({ rows: 52, maxRowsPerPass: 1 });
    expect(s.timers.delays()).toEqual([300_000]);
    s.rec.stop();
  });

  it('positive control: a table read to its end with only permanent failures arms nothing', async () => {
    const s = await scripted({ rows: 3, maxRowsPerPass: 1 });
    expect(s.timers.requested()).toEqual([]);
    s.rec.stop();
  });
});

describe('reconcile: a failed document step wakes itself with a growing wait (I-2)', () => {
  it('resolvePending failing (document busy): wakes after 5 s, 10 s, 20 s ... up to 5 minutes, then a success clears it', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.resolve.mockRejectedValue(new Error('DOC_BUSY'));
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.delays()).toEqual([5_000]);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'uploaded' });
    expect(s.world.files.paths()).toEqual(['media/p1.jpg']);
    const waits = [5_000];
    for (let i = 0; i < 9; i += 1) {
      s.clock.advance(s.timers.delays()[0] ?? 0);
      s.timers.fireNext();
      await s.rec.idle();
      waits.push(s.timers.delays()[0] ?? 0);
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000]);
    expect(s.plugin.starts).toHaveLength(1);
    s.resolve.mockResolvedValue('resolved');
    s.clock.advance(300_000);
    s.timers.fireNext();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
  });

  it('store.delete failing after a resolve: wakes after 5 s and finishes the deletion', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    const realDelete = s.world.store.delete.bind(s.world.store);
    let failing = true;
    s.world.store.delete = async (id) => {
      if (failing) throw new Error('database is locked');
      await realDelete(id);
    };
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.delays()).toEqual([5_000]);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'uploaded' });
    failing = false;
    s.clock.advance(5_000);
    s.timers.fireNext();
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
  });

  it('a photo deleted while its document step waits leaves nothing to re-arm', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.resolve.mockRejectedValue(new Error('DOC_FAILED'));
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.pending()).toBe(1);
    await s.world.store.delete('p1');
    s.clock.advance(5_000);
    s.timers.fireNext();
    await s.rec.idle();
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
  });
});

describe('reconcile: the manual retry wakes the reconciler (f)', () => {
  it('uploader.retry() on a photo that was refused for good runs the reconciler without any other trigger', async () => {
    const s = await setup();
    await putPhotos(s, ['p1']);
    s.world.engine.mintOverride = () => response(413);
    s.rec.start();
    await s.rec.idle();
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    s.world.engine.mintOverride = null;
    await expect(s.uploader.retry('p1')).resolves.toBe(true);
    await s.rec.idle();
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.world.engine.objects.size).toBe(1);
    s.rec.stop();
  });
});
