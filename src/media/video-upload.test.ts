import { describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createManualClock } from '../platform/clock';
import { createNativeUploader, MAX_UPLOAD_ATTEMPTS, TRANSIENT_BACKOFF_CAP_MS, type NativeUploader } from './native-uploader';
import { createMediaReconciler, DOC_RETRY_CAP_MS, type MediaReconciler, type ResolvePending } from './reconcile';
import { MAX_VIDEO_BYTES } from './store';
import { combinedEngine, createFakeVideoEngine, STREAM_HOST, videoBytes, videoRecord, type Backend, type FakeVideoEngine } from './test-support/video-fakes';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN, photoRecord, type FakePlugin, type MediaWorld } from './test-support/fakes';
import { createVideoStrategy, type ResolveVideo } from './video';

const CLIENT_HEADERS = { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' };
const SESSION_OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as const;
const KEY1 = `tenant-1/inspections/${INSPECTION}/videos/media-1.mp4`;
const UID1 = 'streamuid00000001';

function fakeNetwork(initial = true) {
  let online = initial;
  return {
    online: () => Promise.resolve(online),
    onChange: () => () => undefined,
    set(next: boolean) {
      online = next;
    },
  };
}

interface Setup {
  world: MediaWorld;
  video: FakeVideoEngine;
  plugin: FakePlugin;
  timers: ReturnType<typeof createManualTimers>;
  clock: ReturnType<typeof createManualClock>;
  network: ReturnType<typeof fakeNetwork>;
  state: { locked: boolean; token: string | null };
  log: string[];
  errors: unknown[];
  http: ReturnType<typeof combinedEngine>['http'];
  resolvePhoto: ReturnType<typeof vi.fn<ResolvePending>>;
  resolveVideo: ReturnType<typeof vi.fn<ResolveVideo>>;
  uploader: NativeUploader;
  rec: MediaReconciler;
}

interface SetupOptions {
  backend?: Backend;
  world?: MediaWorld;
  video?: FakeVideoEngine;
  wired?: boolean;
  concurrency?: number;
  maxRowsPerPass?: number;
  kinds?: ('photo' | 'video')[] | 'default';
  withResolveVideo?: boolean;
  clock?: ReturnType<typeof createManualClock>;
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const world = options.world ?? (await createMediaWorld());
  const video = options.video ?? createFakeVideoEngine(options.backend ?? 'r2');
  const combined = combinedEngine(world.engine, video);
  const plugin = createFakePlugin({ engine: combined, files: world.files });
  const timers = createManualTimers();
  const clock = options.clock ?? createManualClock(1_000_000);
  const network = fakeNetwork();
  const state = { locked: false, token: 'access-token-secret' as string | null };
  const log: string[] = [];
  const errors: unknown[] = [];
  const originalDelete = world.store.delete.bind(world.store);
  world.store.delete = async (id) => {
    log.push(`delete:${id}`);
    await originalDelete(id);
  };
  const resolvePhoto = vi.fn<ResolvePending>((_inspectionId, pendingId) => {
    log.push(`resolve-photo:${pendingId}`);
    return Promise.resolve('resolved');
  });
  const resolveVideo = vi.fn<ResolveVideo>((_inspectionId, pendingId) => {
    log.push(`resolve-video:${pendingId}:finalizes=${String(video.finalizes.length)}`);
    return Promise.resolve('resolved');
  });
  const uploader = createNativeUploader({
    store: world.store,
    http: combined.http,
    tokens: { getAccessToken: () => Promise.resolve(state.token), checkSession: () => Promise.resolve(SESSION_OK) },
    plugin,
    origin: ORIGIN,
    isLocked: () => state.locked,
    clientHeaders: CLIENT_HEADERS,
    timers,
    clock,
    random: () => 1,
    onError: (e) => errors.push(e),
    ...(options.wired === false ? {} : { video: createVideoStrategy() }),
  });
  const kinds = options.kinds === 'default' ? undefined : (options.kinds ?? (options.wired === false ? ['photo'] : ['photo', 'video']));
  const rec = createMediaReconciler({
    store: world.store,
    uploader,
    resolvePending: resolvePhoto,
    ...(options.withResolveVideo === false ? {} : { resolveVideo }),
    ...(kinds === undefined ? {} : { kinds }),
    isLocked: () => state.locked,
    network,
    clock,
    timers,
    random: () => 0.5,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.maxRowsPerPass === undefined ? {} : { maxRowsPerPass: options.maxRowsPerPass }),
    onError: (e) => errors.push(e),
  });
  return { world, video, plugin, timers, clock, network, state, log, errors, http: combined.http, resolvePhoto, resolveVideo, uploader, rec };
}

const ref = (pendingId: string, inspectionId = INSPECTION) => ({ pendingId, inspectionId });

/** Settles once the upload has registered for the plugin's events (it arms its timeout timer right after). */
function whenTransferRegistered(s: Setup): Promise<void> {
  return new Promise<void>((resolve) => {
    const original = s.timers.setTimeout;
    s.timers.setTimeout = (callback, ms) => {
      const handle = original(callback, ms);
      resolve();
      return handle;
    };
  });
}

describe('video upload: the two backends', () => {
  it('r2: create-upload with the bearer, the clip to the token route on the pinned origin with no Authorization, then finalize, then the row is uploaded', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    const original = s.plugin.startUpload.bind(s.plugin);
    s.plugin.startUpload = (options) => {
      s.log.push(`start:finalizes=${String(s.video.finalizes.length)}`);
      return original(options);
    };
    const outcome = await s.uploader.uploadDetailed(ref('v1'));
    expect(outcome).toEqual({ ok: true, key: KEY1, reused: false });

    const create = s.http.calls[0];
    expect(create?.url).toBe(`${ORIGIN}/api/inspections/${INSPECTION}/media/video/create-upload`);
    expect(create?.method).toBe('POST');
    expect(create?.headers).toMatchObject({ Authorization: 'Bearer access-token-secret', 'content-type': 'application/json' });
    expect(s.video.creates).toEqual([{ inspectionId: INSPECTION, body: { itemId: 'i1' } }]);

    expect(s.plugin.starts).toHaveLength(1);
    const start = s.plugin.starts[0];
    expect(start).toMatchObject({ filePath: 'file:///media/v1.mp4', method: 'POST', uploadType: 'multipart', fileField: 'file', maxRetries: 3, mimeType: 'video/mp4', notificationTitle: 'Uploading videos' });
    expect(start?.serverUrl.startsWith(`${ORIGIN}/api/public/uploads/video?token=`)).toBe(true);
    expect(start?.headers).toEqual(CLIENT_HEADERS);

    expect(s.log).toEqual(['start:finalizes=0']);
    expect(s.video.finalizes).toEqual([{ inspectionId: INSPECTION, body: { provider: 'r2', mediaId: 'media-1', r2Key: KEY1 } }]);
    expect(s.http.calls[1]?.headers).toMatchObject({ Authorization: 'Bearer access-token-secret' });
    expect(s.video.objects.get(KEY1)).toEqual(videoBytes());
    expect(s.video.pool.size).toBe(1);
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'uploaded', attempts: 0, uploadedKey: KEY1 });
  });

  it('stream: the clip goes to the documented upload host with no Authorization and no client headers, then finalize with the uid', async () => {
    const s = await setup({ backend: 'stream' });
    await s.world.store.putVideo(videoRecord('v1'));
    const outcome = await s.uploader.uploadDetailed(ref('v1'));
    expect(outcome).toEqual({ ok: true, key: `stream/${UID1}`, reused: false });
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.plugin.starts[0]?.serverUrl).toBe(`https://${STREAM_HOST}/${UID1}`);
    // The third-party host learns nothing about the app or the account: no bearer, no platform or version header.
    expect(s.plugin.starts[0]?.headers).toEqual({});
    expect(s.video.finalizes).toEqual([{ inspectionId: INSPECTION, body: { provider: 'stream', streamUid: UID1 } }]);
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'uploaded', uploadedKey: `stream/${UID1}` });
    expect(s.video.objects.has(UID1)).toBe(true);
  });

  it('r2 with video/quicktime: the real key carries .mov (the placeholder .mp4 is never finalized)', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('m1', { type: 'video/quicktime' }));
    const mov = `tenant-1/inspections/${INSPECTION}/videos/media-1.mov`;
    expect(await s.uploader.uploadDetailed(ref('m1'))).toEqual({ ok: true, key: mov, reused: false });
    expect(s.plugin.starts[0]?.mimeType).toBe('video/quicktime');
    expect(s.video.finalizes[0]?.body).toEqual({ provider: 'r2', mediaId: 'media-1', r2Key: mov });
    expect(s.video.objects.has(mov)).toBe(true);
    expect(s.video.objects.has(KEY1)).toBe(false);
    expect([...s.video.pool.keys()]).toEqual([mov]);
  });

  it('create-upload and finalize are made for the inspection of the row, and a second inspection gets its own', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('a1'));
    await s.world.store.putVideo(videoRecord('b1', { inspectionId: 'insp-2' }));
    expect((await s.uploader.uploadDetailed(ref('a1'))).ok).toBe(true);
    expect((await s.uploader.uploadDetailed(ref('b1', 'insp-2'))).ok).toBe(true);
    expect(s.video.creates.map((c) => c.inspectionId)).toEqual([INSPECTION, 'insp-2']);
    expect(s.video.finalizes.map((f) => f.inspectionId)).toEqual([INSPECTION, 'insp-2']);
    expect(s.video.finalizes.map((f) => (f.body as { r2Key: string }).r2Key.split('/')[2])).toEqual([INSPECTION, 'insp-2']);
    // A caller that names another inspection than the row's gets nothing and the network is not touched again.
    const calls = s.http.calls.length;
    expect(await s.uploader.uploadDetailed(ref('a1', 'insp-2'))).toMatchObject({ ok: false, code: 'INVALID' });
    expect(s.http.calls.length).toBe(calls);
  });
});

describe('video upload: where the clip may be sent', () => {
  const cases: { name: string; backend: Backend; prepare: (video: FakeVideoEngine) => void }[] = [
    { name: 'stream: a look-alike suffix host', backend: 'stream', prepare: (v) => { v.uploadUrlOverride = (m) => m.replace(STREAM_HOST, `${STREAM_HOST}.evil.test`); } },
    { name: 'stream: another host entirely', backend: 'stream', prepare: (v) => { v.uploadUrlOverride = () => 'https://collector.evil.test/streamuid00000001'; } },
    { name: 'stream: plain http', backend: 'stream', prepare: (v) => { v.uploadUrlOverride = (m) => m.replace('https:', 'http:'); } },
    { name: 'stream: the url names another uid than the ref', backend: 'stream', prepare: (v) => { v.refOverride = (r) => ({ ...r, streamUid: 'otheruid000000009' }); } },
    { name: 'r2: the photo path', backend: 'r2', prepare: (v) => { v.uploadUrlOverride = (m) => m.replace('uploads/video', 'uploads/photo'); } },
    { name: 'r2: a stream-host url under an r2 ref', backend: 'r2', prepare: (v) => { v.uploadUrlOverride = () => `https://${STREAM_HOST}/streamuid00000001`; } },
    { name: 'r2: a key of another inspection', backend: 'r2', prepare: (v) => { v.refOverride = (r) => ({ ...r, r2Key: 'tenant-1/inspections/other-insp/videos/media-1.mp4' }); } },
    { name: 'r2: a media id that is not the key', backend: 'r2', prepare: (v) => { v.refOverride = (r) => ({ ...r, mediaId: 'media-9' }); } },
    { name: 'r2: a key outside the videos folder', backend: 'r2', prepare: (v) => { v.refOverride = (r) => ({ ...r, r2Key: `tenant-1/inspections/${INSPECTION}/photos/media-1.mp4` }); } },
    { name: 'r2: a key with a path escape', backend: 'r2', prepare: (v) => { v.refOverride = (r) => ({ ...r, r2Key: `tenant-1/inspections/${INSPECTION}/videos/../media-1.mp4` }); } },
  ];

  it.each(cases)('refuses $name: nothing is sent, nothing is finalized, the row is given up (positive control: the next clip with a good answer uploads)', async ({ backend, prepare }) => {
    const s = await setup({ backend });
    prepare(s.video);
    await s.world.store.putVideo(videoRecord('bad'));
    const outcome = await s.uploader.uploadDetailed(ref('bad'));
    expect(outcome).toEqual({ ok: false, code: 'BAD_URL', retryable: false, retryAfterMs: null, halt: false });
    expect(s.plugin.starts).toEqual([]);
    expect(s.video.finalizes).toEqual([]);
    expect(await s.world.store.getRow('bad')).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });

    s.video.uploadUrlOverride = null;
    s.video.refOverride = null;
    await s.world.store.putVideo(videoRecord('good'));
    expect((await s.uploader.uploadDetailed(ref('good'))).ok).toBe(true);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it.each([
    ['a foreign host', (m: string) => m.replace(ORIGIN, 'https://evil.test')],
    ['a dev tunnel host and port', (m: string) => m.replace(ORIGIN, 'https://dev-tunnel.example.net:8443')],
    ['http instead of https', (m: string) => m.replace('https:', 'http:')],
    ['a relative path', (m: string) => m.replace(ORIGIN, '')],
  ])('r2: the engine names itself by %s: the transfer still goes to the pinned origin, rebuilt from path and token only', async (_name, rewrite) => {
    const s = await setup();
    s.video.uploadUrlOverride = rewrite;
    await s.world.store.putVideo(videoRecord('rel'));
    expect((await s.uploader.uploadDetailed(ref('rel'))).ok).toBe(true);
    expect(s.plugin.starts).toHaveLength(1);
    const sent = s.plugin.starts[0]?.serverUrl ?? '';
    expect(sent).toBe(`${ORIGIN}/api/public/uploads/video?token=vtoken0001.vsignature0001`);
    expect(sent).not.toMatch(/evil|dev-tunnel|8443|http:/);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it('r2: the real engine absolute url on the pinned host is the positive control and is sent unchanged', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('abs'));
    expect((await s.uploader.uploadDetailed(ref('abs'))).ok).toBe(true);
    expect(s.plugin.starts[0]?.serverUrl).toBe(`${ORIGIN}/api/public/uploads/video?token=vtoken0001.vsignature0001`);
  });

  it('a well-formed answer whose provider is not the provider of its ref is refused too', async () => {
    const s = await setup();
    s.video.refOverride = () => ({ provider: 'stream', streamUid: UID1 });
    await s.world.store.putVideo(videoRecord('x1'));
    expect(await s.uploader.uploadDetailed(ref('x1'))).toMatchObject({ ok: false, code: 'BAD_URL', retryable: false });
    expect(s.plugin.starts).toEqual([]);
    s.video.refOverride = null;
    await s.world.store.putVideo(videoRecord('x2'));
    expect((await s.uploader.uploadDetailed(ref('x2'))).ok).toBe(true);
  });
});

describe('video upload: only a 2xx upload of this clip is followed by finalize', () => {
  it.each([
    [301, 'SERVER', true],
    [302, 'SERVER', true],
    [400, 'REJECTED', false],
    [404, 'REJECTED', false],
    [413, 'REJECTED', false],
    [415, 'REJECTED', false],
    [500, 'SERVER', true],
    [503, 'SERVER', true],
  ] as const)('a completed event with %i is a %s failure and finalize is never called', async (status, code, retryable) => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: status };
    await s.world.store.putVideo(videoRecord('v1'));
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code, retryable });
    expect(s.video.finalizes).toEqual([]);
    expect((await s.world.store.getRow('v1'))?.state).toBe('failed');
    expect((await s.world.store.getRow('v1'))?.uploadedKey).toBeNull();
  });

  it.each([200, 201, 204, 299])('a completed event with %i is the success it should be (control): finalize runs once', async (status) => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: status };
    await s.world.store.putVideo(videoRecord('v1'));
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it('a failed event, even one that carries a 200, and an event without a status do not count as an upload', async () => {
    const s = await setup();
    s.plugin.script = [{ kind: 'fail', statusCode: 200 }, { kind: 'fail' }];
    await s.world.store.putVideo(videoRecord('v1'));
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, retryable: true });
    s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, retryable: true });
    expect(s.video.finalizes).toEqual([]);
    s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it('an event for another upload id does not complete this one: finalize waits for the event of this transfer', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    await s.world.store.putVideo(videoRecord('v1'));
    const registered = whenTransferRegistered(s);
    const done = s.uploader.uploadDetailed(ref('v1'));
    await registered;
    s.plugin.emit({ name: 'completed', id: 'someone-else', eventId: 'ev-other', payload: { statusCode: 200 } });
    expect(s.video.finalizes).toEqual([]);
    expect(s.uploader.isActive('v1')).toBe(true);
    s.plugin.finish(s.plugin.heldIds()[0] ?? '');
    expect((await done).ok).toBe(true);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it('a plugin that cannot start the transfer is a failure with no finalize', async () => {
    const s = await setup();
    s.plugin.script = [{ kind: 'reject' }];
    await s.world.store.putVideo(videoRecord('v1'));
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'FILE' });
    expect(s.video.finalizes).toEqual([]);
  });
});

describe('video upload: kill recovery', () => {
  it('finalize is idempotent: its answer lost, then a restart, finalizes again with the same pool row and uploads nothing twice', async () => {
    const s1 = await setup();
    await s1.world.store.putVideo(videoRecord('v1'));
    s1.video.loseNextFinalizeAnswer();
    expect(await s1.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'NETWORK', retryable: true });
    expect(s1.video.pool.size).toBe(1);
    const stored = await s1.world.store.getRow('v1');
    expect(stored).toMatchObject({ state: 'failed', attempts: 1, uploadedKey: KEY1 });
    // The process dies here: a row that was being worked on is left `uploading`.
    await s1.world.store.markState('v1', 'uploading', { attempts: 1 });

    const s2 = await setup({ world: s1.world, video: s1.video });
    await expect(s2.rec.reconcileUploads()).resolves.toEqual({ retried: 1, confirmed: 1 });
    expect(s1.video.creates).toHaveLength(1);
    expect(s1.plugin.starts).toHaveLength(1);
    expect(s2.plugin.starts).toEqual([]);
    expect(s1.video.finalizes).toHaveLength(2);
    expect(s1.video.pool.size).toBe(1);
    expect(s2.resolveVideo).toHaveBeenCalledTimes(1);
    expect(s2.resolveVideo).toHaveBeenCalledWith(INSPECTION, 'v1', { provider: 'r2', mediaId: 'media-1', r2Key: KEY1 });
    expect(await s2.world.store.getRow('v1')).toBeNull();
    expect(s2.world.files.paths()).toEqual([]);
  });

  it('a kill during the transfer after the token expired: create-upload is made again and the clip lands under the new slot once', async () => {
    const s1 = await setup();
    s1.plugin.defaultBehavior = { kind: 'hang' };
    await s1.world.store.putVideo(videoRecord('v1'));
    void s1.uploader.uploadDetailed(ref('v1'));
    await s1.plugin.whenStarted(1);
    expect((await s1.world.store.getRow('v1'))?.state).toBe('uploading');
    // The process is killed with the transfer unreported, and the token is long past its life.
    s1.video.expireTokens();

    const s2 = await setup({ world: s1.world, video: s1.video });
    await expect(s2.rec.reconcileUploads()).resolves.toEqual({ retried: 1, confirmed: 1 });
    expect(s1.video.creates).toHaveLength(2);
    expect(s2.plugin.starts).toHaveLength(1);
    expect(s2.plugin.starts[0]?.serverUrl).toContain('vtoken0002');
    expect(s1.video.finalizes.map((f) => (f.body as { mediaId: string }).mediaId)).toEqual(['media-2']);
    expect(s1.video.pool.size).toBe(1);
    expect(s1.video.objects.size).toBe(1);
    expect(await s2.world.store.getRow('v1')).toBeNull();
  });

  it('an expired token seen as a 401 by the upload gets a fresh create-upload once (control: with a fresh token it succeeds)', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.plugin.script = [{ kind: 'complete', statusCode: 401 }];
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.video.creates).toHaveLength(2);
    expect(s.plugin.starts).toHaveLength(2);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it('a clip whose transfer finished but whose finalize is owed resumes at finalize: no new create-upload, no second transfer', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.finalizeStatuses.push(503);
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'SERVER', retryable: true });
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'failed', uploadedKey: KEY1 });
    s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
    expect(await s.uploader.uploadDetailed(ref('v1'))).toEqual({ ok: true, key: KEY1, reused: false });
    expect(s.video.creates).toHaveLength(1);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.video.finalizes).toHaveLength(2);
    expect(s.video.pool.size).toBe(1);
    expect((await s.world.store.getRow('v1'))?.state).toBe('uploaded');
  });

  it('a stored key that is not this clip\'s own (another inspection) is ignored: the clip is sent again (control: its own key resumes, above)', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    await s.world.store.markState('v1', 'failed', { attempts: 1, uploadedKey: 'tenant-1/inspections/other-insp/videos/media-7.mp4' });
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.video.creates).toHaveLength(1);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.video.finalizes[0]?.body).toMatchObject({ r2Key: KEY1 });
  });
});

describe('video reconcile: resolve, then delete', () => {
  it('finalize, then the document step, then the file and the row are removed, in that order', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.log).toEqual(['resolve-video:v1:finalizes=1', 'delete:v1']);
    expect(s.resolveVideo).toHaveBeenCalledWith(INSPECTION, 'v1', { provider: 'r2', mediaId: 'media-1', r2Key: KEY1 });
    expect(s.world.files.paths()).toEqual([]);
    expect(await s.world.store.getRow('v1')).toBeNull();
  });

  it('stream: the document step receives the uid', async () => {
    const s = await setup({ backend: 'stream' });
    await s.world.store.putVideo(videoRecord('v1'));
    await s.rec.reconcileUploads();
    expect(s.resolveVideo).toHaveBeenCalledWith(INSPECTION, 'v1', { provider: 'stream', streamUid: UID1 });
  });

  it('a failing document step keeps the file and the row and does not finalize or upload again; the next run finishes it', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.resolveVideo.mockRejectedValueOnce(new Error('doc busy'));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.world.files.paths()).toEqual(['media/v1.mp4']);
    expect(s.log).toEqual([]);
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'uploaded', uploadedKey: KEY1 });
    expect(s.errors).toHaveLength(1);
    s.clock.advance(DOC_RETRY_CAP_MS);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.video.finalizes).toHaveLength(1);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.log).toEqual(['resolve-video:v1:finalizes=1', 'delete:v1']);
    expect(s.world.files.paths()).toEqual([]);
  });

  it('a transient finalize failure never reaches the document step and never deletes the file', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.finalizeStatuses.push(503);
    await s.rec.reconcileUploads();
    expect(s.resolveVideo).not.toHaveBeenCalled();
    expect(s.log).toEqual([]);
    expect(s.world.files.paths()).toEqual(['media/v1.mp4']);
  });

  it('a clip the document does not mention yet is kept like a photo: file and row stay, nothing is deleted, the count shows it', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.resolveVideo.mockResolvedValue('missing');
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'uploaded' });
    expect(s.world.files.paths()).toEqual(['media/v1.mp4']);
    expect(s.log.filter((entry) => entry.startsWith('delete:'))).toEqual([]);
    expect(s.rec.countUnreferenced()).toBe(1);
    expect(s.timers.delays()).toEqual([60_000]);
  });

  it('missing, then the entry appears, then resolved: the clip is re-checked after the backoff and released only then (no second transfer or finalize)', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.resolveVideo.mockResolvedValueOnce('missing');
    await s.rec.reconcileUploads();
    expect(s.resolveVideo).toHaveBeenCalledTimes(1);
    // Inside the wait nothing is asked again.
    s.clock.advance(59_999);
    await s.rec.reconcileUploads();
    expect(s.resolveVideo).toHaveBeenCalledTimes(1);
    // The placeholder entry has been written meanwhile.
    s.resolveVideo.mockResolvedValue('resolved');
    s.clock.advance(1);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.resolveVideo).toHaveBeenCalledTimes(2);
    expect(await s.world.store.getRow('v1')).toBeNull();
    expect(s.rec.countUnreferenced()).toBe(0);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it('a clip that stays missing backs off like a photo (1 min doubling to an hour) and is never deleted', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.resolveVideo.mockResolvedValue('missing');
    await s.rec.reconcileUploads();
    let calls = 1;
    for (let miss = 1; miss <= 8; miss += 1) {
      const wait = Math.min(60_000 * 2 ** (miss - 1), 3_600_000);
      s.clock.advance(wait);
      await s.rec.reconcileUploads();
      calls += 1;
      expect(s.resolveVideo).toHaveBeenCalledTimes(calls);
    }
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'uploaded' });
    expect(s.world.files.paths()).toEqual(['media/v1.mp4']);
    s.rec.stop();
  });
});

describe('video upload: locked, revoked, signed out, offline', () => {
  it('a locked or revoked device makes no request and starts no transfer; unlocked, the same clip goes through (control)', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.state.locked = true;
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'LOCKED', halt: true });
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.http.calls).toEqual([]);
    expect(s.plugin.starts).toEqual([]);
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'pending', attempts: 0 });
    s.state.locked = false;
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
  });

  it('locking after the transfer and before finalize sends no finalize; unlocking resumes at finalize without a second transfer', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    await s.world.store.putVideo(videoRecord('v1'));
    const done = s.uploader.uploadDetailed(ref('v1'));
    await s.plugin.whenStarted(1);
    s.state.locked = true;
    s.plugin.finish(s.plugin.heldIds()[0] ?? '');
    expect(await done).toMatchObject({ ok: false, code: 'LOCKED', halt: true });
    expect(s.video.finalizes).toEqual([]);
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'pending', attempts: 0, uploadedKey: KEY1 });
    s.state.locked = false;
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.video.creates).toHaveLength(1);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it('signed out: no network call; offline: the reconciler does nothing (control: back online it uploads)', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.state.token = null;
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'AUTH', halt: true });
    expect(s.http.calls).toEqual([]);
    s.state.token = 'access-token-secret';
    s.network.set(false);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(s.http.calls).toEqual([]);
    expect(s.plugin.starts).toEqual([]);
    s.network.set(true);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
  });

  it('an uploader without the video strategy leaves a video row alone (not failed, not tried)', async () => {
    const s = await setup({ wired: false });
    await s.world.store.putVideo(videoRecord('v1'));
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'UNSUPPORTED_KIND', retryable: false });
    expect(s.http.calls).toEqual([]);
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe('video upload: weak networks never give up, refusals do', () => {
  it('a dead network on create-upload is retried for ever with growing waits (attempts saturate below the given-up marker)', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.down = true;
    for (let i = 0; i < 40; i += 1) {
      s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
      expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'NETWORK', retryable: true });
    }
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'failed', attempts: 40 });
    expect(s.uploader.retryAt('v1')).toBeGreaterThan(s.clock.now());
    s.video.down = false;
    s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.video.finalizes).toHaveLength(1);
  });

  it('repeated 503 on finalize keeps the clip, transfers it once, and finalizes once it answers', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.finalizeStatuses.push(...Array.from({ length: 12 }, () => 503));
    for (let i = 0; i < 12; i += 1) {
      s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
      expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'SERVER', retryable: true });
    }
    s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.video.pool.size).toBe(1);
  });

  it.each([400, 403, 404, 413, 415, 422])('a %i from create-upload is a permanent refusal that uses every attempt, makes no more requests, and waits for the manual retry', async (status) => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.createStatuses.push(status);
    expect(await s.uploader.uploadDetailed(ref('v1'))).toEqual({ ok: false, code: 'REJECTED', retryable: false, retryAfterMs: null, halt: false });
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    const calls = s.http.calls.length;
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'REJECTED', retryable: false });
    await s.rec.reconcileUploads();
    expect(s.http.calls.length).toBe(calls);
    await expect(s.uploader.retry('v1')).resolves.toBe(true);
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
  });

  it.each([503, 429, 500])('a %i from create-upload is transient: the quota or outage may pass', async (status) => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.createStatuses.push(status);
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'SERVER', retryable: true });
    expect((await s.world.store.getRow('v1'))?.attempts).toBe(1);
  });

  it.each([false, 'omit'] as const)('r2: a finalize 2xx whose readyToStream is %s means the object is not at the expected key: transient, kept, no document step; true finalizes (control)', async (ready) => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.finalizeReady = ready;
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'SERVER', retryable: true });
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'failed', uploadedKey: KEY1 });
    expect((await s.world.store.getRow('v1'))?.attempts).toBeLessThan(MAX_UPLOAD_ATTEMPTS);
    expect(s.resolveVideo).not.toHaveBeenCalled();
    s.video.finalizeReady = true;
    s.clock.advance(TRANSIENT_BACKOFF_CAP_MS);
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.plugin.starts).toHaveLength(1);
  });

  it('stream: readyToStream false is legitimate right after the upload and finalizes', async () => {
    const s = await setup({ backend: 'stream' });
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.finalizeReady = false;
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
  });

  it('a 404 from finalize is permanent after the transfer; the clip stays on the device and the row is visible', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.finalizeStatuses.push(404);
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'REJECTED', retryable: false });
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    expect(s.world.files.paths()).toEqual(['media/v1.mp4']);
    expect(s.resolveVideo).not.toHaveBeenCalled();
  });

  it('a 426 from create-upload halts the run (client too old) without costing the clip an attempt', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.createStatuses.push(426);
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'UPGRADE', halt: true });
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe('video upload: nothing from outside is kept or repeated', () => {
  it('server text never reaches an outcome, a row or the error reporter; the rows hold neither a token nor a url', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.createStatuses.push(500);
    const failed = await s.uploader.uploadDetailed(ref('v1'));
    s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
    s.video.finalizeStatuses.push(500);
    const failedAgain = await s.uploader.uploadDetailed(ref('v1'));
    s.clock.advance(TRANSIENT_BACKOFF_CAP_MS + 1);
    const done = await s.uploader.uploadDetailed(ref('v1'));
    expect(done.ok).toBe(true);
    const everything = JSON.stringify([failed, failedAgain, done, s.errors, await s.world.db.query('SELECT * FROM media')]);
    for (const secret of ['secret server text', 'access-token-secret', 'vtoken', 'vsignature', 'token=', 'http']) expect(everything).not.toContain(secret);
  });

  it('the stream row holds only the uid, and the transfer carries no token', async () => {
    const s = await setup({ backend: 'stream' });
    await s.world.store.putVideo(videoRecord('v1'));
    await s.uploader.uploadDetailed(ref('v1'));
    const rows = JSON.stringify(await s.world.db.query('SELECT * FROM media'));
    expect(rows).toContain(`stream/${UID1}`);
    expect(rows).not.toContain('http');
    expect(JSON.stringify(s.plugin.starts[0]?.headers)).not.toContain('access-token-secret');
  });

  it('a clip whose file grew past the limit behind the app\'s back is refused before any request; a normal size passes (control)', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('big'));
    s.world.files.setSize('media/big.mp4', MAX_VIDEO_BYTES + 1);
    expect(await s.uploader.uploadDetailed(ref('big'))).toMatchObject({ ok: false, code: 'TOO_LARGE', retryable: false });
    await s.world.store.putVideo(videoRecord('zero'));
    s.world.files.setSize('media/zero.mp4', 0);
    expect(await s.uploader.uploadDetailed(ref('zero'))).toMatchObject({ ok: false, code: 'FILE', retryable: false });
    expect(s.http.calls).toEqual([]);
    await s.world.store.putVideo(videoRecord('ok'));
    s.world.files.setSize('media/ok.mp4', MAX_VIDEO_BYTES);
    expect((await s.uploader.uploadDetailed(ref('ok'))).ok).toBe(true);
  });

  it('a missing file is a permanent FILE failure with no request', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    await s.world.files.remove('media/v1.mp4');
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'FILE', retryable: false });
    expect(s.http.calls).toEqual([]);
  });

  it('forwards the transfer progress of a clip', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    await s.world.store.putVideo(videoRecord('v1'));
    const events: [string, number][] = [];
    const registered = whenTransferRegistered(s);
    const done = s.uploader.uploadDetailed(ref('v1'), { onProgress: (id, percent) => events.push([id, percent]) });
    await registered;
    const id = s.plugin.heldIds()[0] ?? '';
    s.plugin.emit({ name: 'uploading', id, payload: { percent: 40 } });
    s.plugin.finish(id);
    await done;
    expect(events).toEqual([['v1', 40]]);
  });
});

describe('video upload: the timeout is a silence timeout with an absolute ceiling', () => {
  const SILENCE = 10 * 60_000;
  const CEILING = 6 * 3_600_000;

  async function startHeld(s: Setup, pendingId: string) {
    s.plugin.defaultBehavior = { kind: 'hang' };
    await s.world.store.putVideo(videoRecord(pendingId));
    const done = s.uploader.uploadDetailed(ref(pendingId));
    await s.plugin.whenStarted(1);
    await vi.waitFor(() => expect(s.timers.pending()).toBe(2));
    return { done, id: s.plugin.heldIds()[0] ?? '' };
  }

  it('arms one silence timer of 10 minutes and one ceiling timer of 6 hours', async () => {
    const s = await setup();
    const { done, id } = await startHeld(s, 'v1');
    expect([...s.timers.delays()].sort((a, b) => a - b)).toEqual([SILENCE, CEILING]);
    s.plugin.finish(id);
    expect((await done).ok).toBe(true);
    expect(s.timers.pending()).toBe(0);
  });

  it('every progress event restarts the silence timer, so a slow transfer is never aborted while it moves', async () => {
    const s = await setup();
    const { done, id } = await startHeld(s, 'v1');
    const before = s.timers.requested().length;
    for (let i = 1; i <= 5; i += 1) {
      s.plugin.emit({ name: 'uploading', id, payload: { percent: i } });
      // The silence timer set before this event is gone and a fresh one stands in its place.
      expect(s.timers.delays().filter((ms) => ms === SILENCE)).toHaveLength(1);
      expect(s.timers.requested().length).toBe(before + i);
    }
    expect(s.plugin.removed).toEqual([]);
    s.plugin.finish(id);
    expect((await done).ok).toBe(true);
  });

  it('ten minutes of silence aborts: removed from the plugin, TIMEOUT, retryable (control: with progress it was kept, above)', async () => {
    const s = await setup();
    const { done, id } = await startHeld(s, 'v1');
    s.plugin.emit({ name: 'uploading', id, payload: { percent: 10 } });
    s.timers.fireWithDelay(SILENCE);
    await expect(done).resolves.toMatchObject({ ok: false, code: 'TIMEOUT', retryable: true });
    expect(s.plugin.removed).toEqual([id]);
    expect(s.timers.pending()).toBe(0);
  });

  it('the ceiling aborts a transfer that keeps reporting progress', async () => {
    const s = await setup();
    const { done, id } = await startHeld(s, 'v1');
    for (let i = 1; i <= 3; i += 1) s.plugin.emit({ name: 'uploading', id, payload: { percent: i } });
    s.timers.fireWithDelay(CEILING);
    await expect(done).resolves.toMatchObject({ ok: false, code: 'TIMEOUT', retryable: true });
    expect(s.plugin.removed).toEqual([id]);
    expect(s.timers.pending()).toBe(0);
  });

  it('progress of another transfer, and progress after the end, do not restart anything', async () => {
    const s = await setup();
    const { done, id } = await startHeld(s, 'v1');
    const before = s.timers.requested().length;
    s.plugin.emit({ name: 'uploading', id: 'someone-else', payload: { percent: 50 } });
    expect(s.timers.requested().length).toBe(before);
    s.plugin.finish(id);
    await done;
    s.plugin.emit({ name: 'uploading', id, payload: { percent: 99 } });
    expect(s.timers.pending()).toBe(0);
  });

  it('a photo keeps the fixed timeout: progress does not restart it and there is no second timer', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    await s.world.store.put(photoRecord('p1'));
    const done = s.uploader.uploadDetailed(ref('p1'));
    await s.plugin.whenStarted(1);
    await vi.waitFor(() => expect(s.timers.pending()).toBe(1));
    const id = s.plugin.heldIds()[0] ?? '';
    s.plugin.emit({ name: 'uploading', id, payload: { percent: 10 } });
    expect(s.timers.requested()).toHaveLength(1);
    expect(s.timers.delays()).toEqual([SILENCE]);
    s.timers.fireNext();
    await expect(done).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' });
  });
});

describe('video reconcile: one table, two kinds', () => {
  it('photos and clips share the concurrency limit and each kind reaches its own document step', async () => {
    const s = await setup({ concurrency: 2 });
    s.plugin.defaultBehavior = { kind: 'hang' };
    await s.world.store.put(photoRecord('p1', { createdAt: 1 }));
    await s.world.store.putVideo(videoRecord('v1', { createdAt: 2 }));
    await s.world.store.put(photoRecord('p2', { createdAt: 3 }));
    await s.world.store.putVideo(videoRecord('v2', { createdAt: 4 }));
    const run = s.rec.reconcileUploads();
    await s.plugin.whenStarted(2);
    expect(s.plugin.inFlight()).toBe(2);
    expect(s.plugin.starts).toHaveLength(2);
    for (const id of s.plugin.heldIds()) s.plugin.finish(id);
    await s.plugin.whenStarted(4);
    for (const id of s.plugin.heldIds()) s.plugin.finish(id);
    await expect(run).resolves.toEqual({ retried: 0, confirmed: 4 });
    expect(s.plugin.maxInFlight()).toBe(2);
    expect(s.resolvePhoto.mock.calls.map((c) => c[1]).sort()).toEqual(['p1', 'p2']);
    expect(s.resolveVideo.mock.calls.map((c) => c[1]).sort()).toEqual(['v1', 'v2']);
    expect(await s.world.db.query('SELECT * FROM media')).toEqual([]);
  });

  it('the kinds default follows the uploader: with the clip strategy wired, clips are uploaded without naming them', async () => {
    const s = await setup({ kinds: 'default' });
    await s.world.store.put(photoRecord('p1', { createdAt: 1 }));
    await s.world.store.putVideo(videoRecord('v1', { createdAt: 2 }));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 2 });
    expect(s.video.creates).toHaveLength(1);
    expect(await s.world.store.getRow('v1')).toBeNull();
  });

  it('an uploader without the clip strategy and the default kinds work on photos only; a clip row is left alone (control for the constructor errors below)', async () => {
    const s = await setup({ kinds: 'default', wired: false });
    await s.world.store.put(photoRecord('p1', { createdAt: 1 }));
    await s.world.store.putVideo(videoRecord('v1', { createdAt: 2 }));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.video.creates).toEqual([]);
    expect(await s.world.store.getRow('v1')).toMatchObject({ state: 'pending', attempts: 0 });
  });

  describe('construction refuses a wiring that would silently lose clips', () => {
    const build = (s: Setup, extra: Partial<Parameters<typeof createMediaReconciler>[0]>) =>
      createMediaReconciler({
        store: s.world.store,
        uploader: s.uploader,
        resolvePending: s.resolvePhoto,
        isLocked: () => false,
        network: s.network,
        clock: s.clock,
        timers: s.timers,
        ...extra,
      });

    it('video enabled and no resolveVideo: throws (clips would finalize and then be deleted with no placement); with it, it builds', async () => {
      const s = await setup();
      expect(() => build(s, { resolveVideo: s.resolveVideo })).not.toThrow();
      expect(() => build(s, {})).toThrow(/resolveVideo/);
      expect(() => build(s, { kinds: ['photo', 'video'] })).toThrow(/resolveVideo/);
    });

    it('explicit kinds that omit video while the uploader has the strategy: throws; including it builds', async () => {
      const s = await setup();
      expect(() => build(s, { kinds: ['photo'], resolveVideo: s.resolveVideo })).toThrow(/video/);
      expect(() => build(s, { kinds: ['photo', 'video'], resolveVideo: s.resolveVideo })).not.toThrow();
    });

    it('explicit kinds that name video while the uploader has no strategy: throws; photos only builds', async () => {
      const s = await setup({ wired: false });
      expect(() => build(s, { kinds: ['photo', 'video'], resolveVideo: s.resolveVideo })).toThrow(/video/);
      expect(() => build(s, { kinds: ['photo'] })).not.toThrow();
      expect(() => build(s, {})).not.toThrow();
    });
  });

  it('a corrupt row, a given-up row and a row of a kind nobody handles cannot wedge the loop: the good clips behind them finish (paging by the raw rows)', async () => {
    const s = await setup({ maxRowsPerPass: 2 });
    const insert = (id: string, kind: string, type: string, path: string, at: number, state = 'pending', attempts = 0) =>
      s.world.db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, uploaded_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, INSPECTION, kind, path, type, '{}', state, attempts, null, at]);
    await insert('bad-1', 'video', '', 'media/bad-1.', 1);
    await insert('bad-2', 'video', 'video/mp4', 'media/elsewhere.mp4', 2);
    await insert('given-up', 'video', 'video/mp4', 'media/given-up.mp4', 3, 'failed', MAX_UPLOAD_ATTEMPTS);
    await insert('other-kind', 'crop', 'image/jpeg', 'media/other-kind.jpg', 4);
    await s.world.store.putVideo(videoRecord('good-1', { createdAt: 10 }));
    await s.world.store.putVideo(videoRecord('good-2', { createdAt: 11 }));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 2 });
    expect(s.video.creates).toHaveLength(2);
    expect((await s.world.db.query<{ pending_id: string }>('SELECT pending_id FROM media ORDER BY created_at')).map((r) => r.pending_id)).toEqual(['bad-1', 'bad-2', 'given-up', 'other-kind']);
  });
});

describe('video upload: the manual retry', () => {
  it('retry() on a given-up clip with its transfer already done goes straight back to finalize', async () => {
    const s = await setup();
    await s.world.store.putVideo(videoRecord('v1'));
    s.video.finalizeStatuses.push(422);
    expect(await s.uploader.uploadDetailed(ref('v1'))).toMatchObject({ ok: false, code: 'REJECTED', retryable: false });
    await expect(s.uploader.retry('v1')).resolves.toBe(true);
    expect((await s.uploader.uploadDetailed(ref('v1'))).ok).toBe(true);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.video.finalizes).toHaveLength(2);
  });
});
