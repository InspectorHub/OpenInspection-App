import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth/errors';
import type { SessionCheck } from '../auth/tokens';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createNativeUploader, MAX_UPLOAD_ATTEMPTS, type NativeUploaderDeps } from './native-uploader';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN, photoRecord, response, type FakePlugin, type MediaWorld } from './test-support/fakes';

const ID = 'photo-1';
const CLIENT_HEADERS = { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' };
const SESSION_OK: SessionCheck = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } };

interface Setup {
  world: MediaWorld;
  plugin: FakePlugin;
  timers: ReturnType<typeof createManualTimers>;
  state: { locked: boolean; token: string | null };
  tokens: NonNullable<NativeUploaderDeps['tokens']> & { checks: number };
  errors: unknown[];
  uploader: ReturnType<typeof createNativeUploader>;
  progress: [string, number][];
}

async function setup(options: { origin?: string; allowInsecureHttp?: boolean; session?: SessionCheck } = {}): Promise<Setup> {
  const world = await createMediaWorld();
  const plugin = createFakePlugin({ engine: world.engine, files: world.files });
  const timers = createManualTimers();
  const state = { locked: false, token: 'access-token-secret' as string | null };
  const errors: unknown[] = [];
  const progress: [string, number][] = [];
  const tokens = {
    checks: 0,
    getAccessToken: () => Promise.resolve(state.token),
    checkSession: () => {
      tokens.checks += 1;
      return Promise.resolve(options.session ?? SESSION_OK);
    },
  };
  const uploader = createNativeUploader({
    store: world.store,
    http: world.engine.http,
    tokens,
    plugin,
    origin: options.origin ?? ORIGIN,
    ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
    isLocked: () => state.locked,
    clientHeaders: CLIENT_HEADERS,
    timers,
    onError: (e) => errors.push(e),
  });
  return { world, plugin, timers, state, tokens, errors, uploader, progress };
}

const ref = (pendingId = ID) => ({ pendingId, inspectionId: INSPECTION });

describe('native uploader: the happy path', () => {
  it('mints a signed url with the authenticated wrapper, then starts a multipart upload of the stored file', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toEqual({ ok: true, key: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg`, reused: false });

    expect(s.world.engine.http.calls).toHaveLength(1);
    const mint = s.world.engine.http.calls[0];
    expect(mint?.url).toBe(`${ORIGIN}/api/inspections/${INSPECTION}/media/upload-url`);
    expect(mint?.method).toBe('POST');
    expect(mint?.headers).toMatchObject({ Authorization: 'Bearer access-token-secret', 'content-type': 'application/json' });
    expect(JSON.parse(mint?.body ?? '{}')).toEqual({ pendingId: ID, contentType: 'image/jpeg' });

    expect(s.plugin.starts).toHaveLength(1);
    const start = s.plugin.starts[0];
    expect(start).toMatchObject({
      filePath: `file:///media/${ID}.jpg`,
      method: 'POST',
      uploadType: 'multipart',
      fileField: 'file',
      maxRetries: 3,
      mimeType: 'image/jpeg',
    });
    expect(start?.serverUrl.startsWith(`${ORIGIN}/api/public/uploads/photo?token=`)).toBe(true);
    // The signed url carries its own authority: the upload request has no Authorization header, only the client headers.
    expect(start?.headers).toEqual(CLIENT_HEADERS);

    const row = await s.world.store.getRow(ID);
    expect(row).toMatchObject({ state: 'uploaded', attempts: 1, uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg` });
    expect(s.world.engine.objects.size).toBe(1);
    expect(s.timers.pending()).toBe(0);
  });

  it('the field-ui contract: upload() answers { ok: true, key } and never throws', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    const rec = await s.world.store.get(ID);
    expect(rec).not.toBeNull();
    if (!rec) return;
    await expect(s.uploader.upload(rec)).resolves.toEqual({ ok: true, key: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg` });
    s.state.locked = true;
    await expect(s.uploader.upload(rec)).resolves.toEqual({ ok: false, error: 'LOCKED' });
    s.state.locked = false;
    const missing = { ...rec, pendingId: 'nope' };
    await expect(s.uploader.upload(missing)).resolves.toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('forwards progress for the upload it started and ignores other ids', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'hang' };
    const events: [string, number][] = [];
    // The upload's timeout timer is set right after it has registered for events: that is the signal to wait for.
    const registered = new Promise<void>((resolve) => {
      const original = s.timers.setTimeout;
      s.timers.setTimeout = (callback, ms) => {
        const handle = original(callback, ms);
        resolve();
        return handle;
      };
    });
    const done = s.uploader.uploadDetailed(ref(), { onProgress: (id, percent) => events.push([id, percent]) });
    await registered;
    s.plugin.emit({ name: 'uploading', id: 'up-1', payload: { percent: 40 } });
    s.plugin.emit({ name: 'uploading', id: 'other', payload: { percent: 99 } });
    s.plugin.emit({ name: 'uploading', id: 'up-1', payload: { percent: Number.NaN } });
    s.plugin.emit({ name: 'uploading', id: 'up-1', payload: { percent: 400 } });
    s.plugin.finish('up-1');
    await done;
    expect(events).toEqual([[ID, 40], [ID, 100]]);
  });

  it('accepts a completed event that arrives before startUpload has resolved', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'complete-early' };
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome.ok).toBe(true);
    expect(s.plugin.acks).toEqual(['ev-up-1']);
  });

  it('does not start a second upload for an id that is already in flight; both callers get the one answer', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'hang' };
    const a = s.uploader.uploadDetailed(ref());
    const b = s.uploader.uploadDetailed(ref());
    expect(s.uploader.isActive(ID)).toBe(true);
    await s.plugin.whenStarted(1);
    s.plugin.finish('up-1');
    const [first, second] = await Promise.all([a, b]);
    expect(first).toEqual(second);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.world.engine.http.calls).toHaveLength(1);
    expect(s.uploader.isActive(ID)).toBe(false);
  });

  it('an already uploaded row answers with its key and sends nothing (resolve can be retried without a second upload)', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'uploaded', { attempts: 1, uploadedKey: 'k/inspections/i/photos/photo-1.jpg' });
    await expect(s.uploader.uploadDetailed(ref())).resolves.toEqual({ ok: true, key: 'k/inspections/i/photos/photo-1.jpg', reused: true });
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(s.plugin.starts).toHaveLength(0);
  });
});

describe('native uploader: only a 2xx completed event is success', () => {
  it.each([[200], [201], [204], [299]])('completed with %i is uploaded', async (status) => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: status };
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome.ok).toBe(true);
    expect((await s.world.store.getRow(ID))?.state).toBe('uploaded');
  });

  it.each([
    [400, 'REJECTED', false],
    [404, 'REJECTED', false],
    [411, 'REJECTED', false],
    [413, 'REJECTED', false],
    [415, 'REJECTED', false],
    [422, 'REJECTED', false],
    [408, 'SERVER', true],
    [429, 'SERVER', true],
    [500, 'SERVER', true],
    [502, 'SERVER', true],
    [503, 'SERVER', true],
    [301, 'SERVER', true],
    [100, 'SERVER', true],
    [199, 'SERVER', true],
    [300, 'SERVER', true],
  ])('completed with %i (the iOS quirk) is failed with the fixed error %s', async (status, code, retryable) => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: status };
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, code, retryable });
    const row = await s.world.store.getRow(ID);
    expect(row?.state).toBe('failed');
    expect(row?.uploadedKey).toBeNull();
    expect(row?.attempts).toBe(retryable ? 1 : MAX_UPLOAD_ATTEMPTS);
    // The field-ui contract carries only the fixed code.
    const rec = await s.world.store.get(ID);
    if (rec) expect(await s.uploader.upload(rec)).toEqual({ ok: false, error: code });
  });

  it('a completed event without a status code is not a success', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'hang' };
    const done = s.uploader.uploadDetailed(ref());
    await s.plugin.whenStarted(1);
    s.plugin.emit({ name: 'completed', id: 'up-1', eventId: 'e', payload: {} });
    await expect(done).resolves.toMatchObject({ ok: false, retryable: true });
    expect((await s.world.store.getRow(ID))?.state).toBe('failed');
  });

  it('a failed event is failed: network when it has no status, the status class when it has one', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('a'));
    await s.world.store.put(photoRecord('b'));
    s.plugin.script = [{ kind: 'fail' }, { kind: 'fail', statusCode: 413 }];
    await expect(s.uploader.uploadDetailed(ref('a'))).resolves.toMatchObject({ ok: false, code: 'NETWORK', retryable: true });
    await expect(s.uploader.uploadDetailed(ref('b'))).resolves.toMatchObject({ ok: false, code: 'REJECTED', retryable: false });
  });

  it('an unknown event name, a malformed event and events for other ids change nothing', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'hang' };
    const done = s.uploader.uploadDetailed(ref());
    await s.plugin.whenStarted(1);
    s.plugin.emit({ name: 'finished', id: 'up-1' } as never);
    s.plugin.emit({ name: 'completed', id: 42, payload: { statusCode: 500 } } as never);
    s.plugin.emit(null as never);
    s.plugin.emit({ name: 'completed', id: 'someone-else', eventId: 'x', payload: { statusCode: 500 } });
    s.plugin.finish('up-1');
    await expect(done).resolves.toMatchObject({ ok: true });
  });
});

describe('native uploader: a signed url that was refused (401/403) is minted again once', () => {
  it('a 401 on the upload, then success with a freshly minted url', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.uploadStatuses = [401];
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome.ok).toBe(true);
    expect(s.world.engine.http.calls).toHaveLength(2);
    expect(s.plugin.starts).toHaveLength(2);
    expect(s.plugin.starts[0]?.serverUrl).not.toBe(s.plugin.starts[1]?.serverUrl);
    // The attempt is counted once, not once per mint.
    expect((await s.world.store.getRow(ID))?.attempts).toBe(1);
  });

  it('a 403 behaves the same, and a second refusal is a retryable AUTH failure after exactly two starts', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('x'));
    s.world.engine.uploadStatuses = [403];
    expect((await s.uploader.uploadDetailed(ref('x'))).ok).toBe(true);

    await s.world.store.put(photoRecord(ID));
    s.world.engine.uploadStatuses = [401, 401];
    const before = s.plugin.starts.length;
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, code: 'AUTH', retryable: true, halt: false });
    expect(s.plugin.starts.length - before).toBe(2);
    expect((await s.world.store.getRow(ID))?.state).toBe('failed');
  });

  it('a 401 on the mint call refreshes the session and tries again once', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    let refused = false;
    s.world.engine.mintOverride = null;
    const engineHttp = s.world.engine.http;
    const uploader = createNativeUploader({
      store: s.world.store,
      http: {
        request: (req) => {
          if (!refused) {
            refused = true;
            return Promise.resolve(response(401));
          }
          return engineHttp.request(req);
        },
      },
      tokens: s.tokens,
      plugin: s.plugin,
      origin: ORIGIN,
      isLocked: () => false,
      clientHeaders: CLIENT_HEADERS,
      timers: s.timers,
    });
    await expect(uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: true });
    expect(s.tokens.checks).toBe(1);
    expect(engineHttp.calls).toHaveLength(1);
  });

  it.each([['relogin'], ['signed_out']] as const)('a 401 on the mint call with a %s session halts the run and sends nothing', async (kind) => {
    const s = await setup({ session: { kind } });
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(401);
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, code: 'AUTH', halt: true });
    expect(s.plugin.starts).toHaveLength(0);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe('native uploader: mint failures', () => {
  it.each([[403], [404]])('a %i on the mint call is permanent and starts nothing', async (status) => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(status);
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'REJECTED', retryable: false });
    expect(s.plugin.starts).toHaveLength(0);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
  });

  it('429 and 5xx are retryable, count one attempt, and carry a clamped Retry-After', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('a'));
    await s.world.store.put(photoRecord('b'));
    await s.world.store.put(photoRecord('c'));
    const answers = [response(429, undefined, { retryAfterMs: 45_000 }), response(503, undefined, { retryAfterMs: 3_600_000 }), response(500)];
    s.world.engine.mintOverride = () => answers.shift() ?? response(500);
    const a = await s.uploader.uploadDetailed(ref('a'));
    const b = await s.uploader.uploadDetailed(ref('b'));
    const c = await s.uploader.uploadDetailed(ref('c'));
    expect(a).toMatchObject({ ok: false, code: 'SERVER', retryable: true, retryAfterMs: 45_000 });
    expect(b).toMatchObject({ ok: false, code: 'SERVER', retryable: true, retryAfterMs: 300_000 });
    expect(c).toMatchObject({ ok: false, code: 'SERVER', retryable: true, retryAfterMs: null });
    expect(await s.world.store.getRow('a')).toMatchObject({ state: 'failed', attempts: 1 });
    expect(s.plugin.starts).toHaveLength(0);
  });

  it('a network error on the mint call is retryable and does not burn an attempt or touch the row', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    const wrapped = { request: () => Promise.reject(new AuthError('server_unreachable')) };
    const uploader = createNativeUploader({ store: s.world.store, http: wrapped, tokens: s.tokens, plugin: s.plugin, origin: ORIGIN, isLocked: () => false, clientHeaders: CLIENT_HEADERS, timers: s.timers });
    expect(await uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'NETWORK', retryable: true });
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('a malformed mint answer is refused without starting an upload', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    for (const body of [undefined, {}, { success: true }, { success: true, data: { url: 5, key: 'k' } }, { success: false, data: {} }]) {
      s.world.engine.mintOverride = () => response(200, body);
      expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'BAD_URL' });
    }
    expect(s.plugin.starts).toHaveLength(0);
    // Control: the real answer is accepted on the same row.
    s.world.engine.mintOverride = null;
    expect((await s.uploader.uploadDetailed(ref())).ok).toBe(true);
  });
});

describe('native uploader: timeouts, plugin and disk failures', () => {
  it('an upload that never reports is abandoned after the timeout: removed from the plugin, failed, retryable', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'hang' };
    const original = s.timers.setTimeout;
    const timerSet = new Promise<void>((resolve) => {
      s.timers.setTimeout = (callback, ms) => {
        const handle = original(callback, ms);
        resolve();
        return handle;
      };
    });
    const done = s.uploader.uploadDetailed(ref());
    await timerSet;
    expect(s.timers.pending()).toBe(1);
    s.timers.fireNext();
    await expect(done).resolves.toMatchObject({ ok: false, code: 'TIMEOUT', retryable: true });
    expect(s.plugin.removed).toEqual(['up-1']);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(s.timers.pending()).toBe(0);
  });

  it('a startUpload rejection is a fixed FILE failure, never uploaded, and its message does not leak', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'reject' };
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, code: 'FILE', retryable: true });
    expect(JSON.stringify(outcome)).not.toContain('secret');
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: 1, uploadedKey: null });
    expect(JSON.stringify(s.errors)).not.toContain('secret');
  });

  it('a stored file that has gone missing is a permanent FILE failure and nothing is minted', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.files.remove(`media/${ID}.jpg`);
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'FILE', retryable: false });
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
  });

  it('a failure to record the uploaded state is reported, not thrown, and the next pass simply uploads again', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    const original = s.world.store.markState.bind(s.world.store);
    let fail = true;
    s.world.store.markState = (id, state, patch) => {
      if (state === 'uploaded' && fail) {
        fail = false;
        return Promise.reject(new Error('database is locked'));
      }
      return original(id, state, patch);
    };
    await expect(s.uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: true });
    expect(s.errors).toHaveLength(1);
    expect((await s.world.store.getRow(ID))?.state).toBe('uploading');
  });
});

describe('native uploader: refusals before any network call', () => {
  it('an unsupported kind, a foreign inspection id and malformed ids are refused', async () => {
    const s = await setup();
    await s.world.store.put({
      pendingId: 'crop-1', inspectionId: INSPECTION, kind: 'crop', blob: photoRecord('x').blob, createdAt: 1,
      meta: { findingKey: 'k', itemId: 'i', photoIndex: 0, photoKey: 'pk', crop: {} as never },
    });
    await s.world.store.put(photoRecord(ID));
    expect(await s.uploader.uploadDetailed(ref('crop-1'))).toMatchObject({ ok: false, code: 'UNSUPPORTED_KIND' });
    expect(await s.uploader.uploadDetailed({ pendingId: ID, inspectionId: 'another' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await s.uploader.uploadDetailed({ pendingId: '../x', inspectionId: INSPECTION })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await s.uploader.uploadDetailed({ pendingId: ID, inspectionId: 'a/b' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(s.plugin.starts).toHaveLength(0);
    // Control: the matching reference uploads.
    expect((await s.uploader.uploadDetailed(ref())).ok).toBe(true);
  });

  it('attach() registers the plugin listener once and acknowledges events left over from a previous process', async () => {
    const s = await setup();
    await s.uploader.attach();
    await s.uploader.attach();
    expect(s.plugin.listenerCount()).toBe(1);
    s.plugin.emit({ name: 'completed', id: 'old-process-upload', eventId: 'stale-1', payload: { statusCode: 200 } });
    s.plugin.emit({ name: 'failed', id: 'old-process-upload-2', eventId: 'stale-2', payload: { error: 'x' } });
    expect(s.plugin.acks).toEqual(['stale-1', 'stale-2']);
  });

  it('dispose() removes the listener', async () => {
    const s = await setup();
    await s.uploader.attach();
    await s.uploader.dispose();
    expect(s.plugin.listenerCount()).toBe(0);
  });

  it('works against a loopback dev origin only when plain http is allowed', async () => {
    const dev = await setup({ origin: 'http://localhost:8787', allowInsecureHttp: true });
    await dev.world.store.put(photoRecord(ID));
    expect((await dev.uploader.uploadDetailed(ref())).ok).toBe(true);
    expect(dev.plugin.starts[0]?.serverUrl.startsWith('http://localhost:8787/api/public/uploads/photo?token=')).toBe(true);
    expect(() => createNativeUploader({
      store: dev.world.store, http: dev.world.engine.http, tokens: dev.tokens, plugin: dev.plugin, origin: 'http://remote.example.test', isLocked: () => false, clientHeaders: {}, timers: dev.timers,
    })).toThrow();
  });
});

describe('native uploader: sanity of the harness', () => {
  it('records console output so the security tests can rely on it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    console.error('probe');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
