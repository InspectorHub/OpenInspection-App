import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth/errors';
import type { SessionCheck } from '../auth/tokens';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createManualClock } from '../platform/clock';
import { createNativeUploader, MAX_UPLOAD_ATTEMPTS, transientBackoffMs, type NativeUploaderDeps } from './native-uploader';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN, photoRecord, response, type FakePlugin, type MediaWorld } from './test-support/fakes';
import { neverBlocked } from '../test-support/never-blocked';

const ID = 'photo-1';
const CLIENT_HEADERS = { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' };
const SESSION_OK: SessionCheck = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } };

interface Setup {
  world: MediaWorld;
  plugin: FakePlugin;
  timers: ReturnType<typeof createManualTimers>;
  clock: ReturnType<typeof createManualClock>;
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
  const clock = createManualClock(5_000_000);
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
  const uploader = createNativeUploader({ isBlocked: neverBlocked,
    store: world.store,
    http: world.engine.http,
    tokens,
    plugin,
    origin: options.origin ?? ORIGIN,
    ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
    isLocked: () => state.locked,
    clientHeaders: CLIENT_HEADERS,
    timers,
    clock,
    random: () => 1,
    onError: (e) => errors.push(e),
  });
  return { world, plugin, timers, clock, state, tokens, errors, uploader, progress };
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
    expect(row).toMatchObject({ state: 'uploaded', attempts: 0, uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg` });
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
    const key = `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg`;
    await s.world.store.markState(ID, 'uploaded', { attempts: 1, uploadedKey: key });
    await expect(s.uploader.uploadDetailed(ref())).resolves.toEqual({ ok: true, key, reused: true });
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
    // A refused url is not a failed attempt, and a success keeps the count: nothing is used up.
    expect((await s.world.store.getRow(ID))?.attempts).toBe(0);
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
    const uploader = createNativeUploader({ isBlocked: neverBlocked,
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

  it('a network error on the mint call is retryable and counts one attempt, so the row shows as failed (I-6)', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    const wrapped = { request: () => Promise.reject(new AuthError('server_unreachable')) };
    const uploader = createNativeUploader({ isBlocked: neverBlocked, store: s.world.store, http: wrapped, tokens: s.tokens, plugin: s.plugin, origin: ORIGIN, isLocked: () => false, clientHeaders: CLIENT_HEADERS, timers: s.timers, clock: s.clock, random: () => 1 });
    expect(await uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'NETWORK', retryable: true });
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('an unreadable or incomplete mint answer is transient (a captive portal answers like this): nothing is started and it is retried', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    for (const body of [undefined, {}, { success: true }, { success: false, data: {} }]) {
      s.world.engine.mintOverride = () => response(200, body);
      // Each answer is judged on its own: the backoff of the one before must have passed.
      s.clock.advance(3_600_000);
      expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'BAD_URL', retryable: true });
    }
    expect(s.plugin.starts).toHaveLength(0);
    // Control: the real answer is accepted on the same row.
    s.world.engine.mintOverride = null;
    s.clock.advance(3_600_000);
    expect((await s.uploader.uploadDetailed(ref())).ok).toBe(true);
  });

  it.each([
    ['a url that is not a string', { success: true, data: { url: 5, key: 'k' } }],
    ['a url that points elsewhere', { success: true, data: { url: 'https://evil.example.test/api/public/uploads/photo?token=payload0001.signature0001', key: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg` } }],
    ["a key that is not this photo's own", { success: true, data: { url: '/api/public/uploads/photo?token=payload0001.signature0001', key: 'other/key.jpg' } }],
  ])('a well-formed answer with %s is a permanent BAD_URL: every attempt is used at once and nothing is started (I-3)', async (_name, body) => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(200, body);
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'BAD_URL', retryable: false, halt: false });
    expect(s.plugin.starts).toHaveLength(0);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    expect(s.uploader.retryAt(ID)).toBe(0);
    s.world.engine.mintOverride = null;
    s.clock.advance(100 * 3_600_000);
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, retryable: false });
    expect(s.plugin.starts).toHaveLength(0);
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
    expect(() => createNativeUploader({ isBlocked: neverBlocked,
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

describe('native uploader: the policy the editor drain goes through (I-5)', () => {
  it('upload() on a row that was permanently refused answers the stored failure and mints nothing', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(413);
    await s.uploader.uploadDetailed(ref());
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    const calls = s.world.engine.http.calls.length;
    expect(calls).toBe(1);
    const rec = await s.world.store.get(ID);
    if (!rec) throw new Error('record missing');
    for (let i = 0; i < 5; i += 1) {
      s.clock.advance(10 * 3_600_000);
      await expect(s.uploader.upload(rec)).resolves.toEqual({ ok: false, error: 'REJECTED' });
    }
    expect(s.world.engine.http.calls.length).toBe(calls);
    expect(s.plugin.starts).toHaveLength(0);
  });

  it('after a restart (no memory) a row at the cap is answered GIVEN_UP, still without a mint', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'failed', { attempts: MAX_UPLOAD_ATTEMPTS });
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'GIVEN_UP', retryable: false, halt: false });
    expect(s.world.engine.http.calls).toHaveLength(0);
  });

  it('a failed row whose backoff has not elapsed answers the stored failure without minting; after it, the upload goes', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(503);
    await s.uploader.uploadDetailed(ref());
    expect(s.world.engine.http.calls).toHaveLength(1);
    const wait = transientBackoffMs(1, null, () => 1);
    expect(wait).toBe(15_000);
    expect(s.uploader.retryAt(ID)).toBe(s.clock.now() + wait);
    await expect(s.uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: false, code: 'SERVER', retryable: true });
    s.clock.advance(wait - 1);
    await s.uploader.uploadDetailed(ref());
    expect(s.world.engine.http.calls).toHaveLength(1);
    s.clock.advance(1);
    s.world.engine.mintOverride = null;
    await expect(s.uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: true });
    expect(s.uploader.retryAt(ID)).toBeNull();
  });

  it('retry() is the manual override: it clears the cap and the backoff, and the next upload goes', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(413);
    await s.uploader.uploadDetailed(ref());
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    s.world.engine.mintOverride = null;
    await expect(s.uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: false, code: 'REJECTED', retryable: false });
    await expect(s.uploader.retry(ID)).resolves.toBe(true);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'pending', attempts: 0 });
    await expect(s.uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: true });
    await expect(s.uploader.retry('nobody')).resolves.toBe(false);
    await expect(s.uploader.retry('../x')).resolves.toBe(false);
  });
});

describe('native uploader: a weak network never gives a photo up (I-3)', () => {
  const scenarios: [string, (s: Setup) => void][] = [
    ['a mint network error', (s) => { s.world.engine.mintOverride = () => { throw new AuthError('server_unreachable'); }; }],
    ['an unreadable mint answer', (s) => { s.world.engine.mintOverride = () => response(200, { success: true }); }],
    ['a start the plugin refuses', (s) => { s.plugin.defaultBehavior = { kind: 'reject' }; }],
    ['a server error on the mint', (s) => { s.world.engine.mintOverride = () => response(503); }],
    ['an upload the server answers with 502', (s) => { s.plugin.defaultBehavior = { kind: 'complete', statusCode: 502 }; }],
    ['an upload that fails with no status', (s) => { s.plugin.defaultBehavior = { kind: 'fail' }; }],
  ];
  const FAILURES = 20;

  it.each(scenarios)('%s: 20 failures in a row end failed each time, never GIVEN_UP, with non-decreasing delays up to one hour', async (_name, arrange) => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    arrange(s);
    let previous = 0;
    const delays: number[] = [];
    for (let i = 1; i <= FAILURES; i += 1) {
      const at = s.uploader.retryAt(ID);
      if (at !== null) s.clock.set(at);
      const outcome = await s.uploader.uploadDetailed(ref());
      expect(outcome, String(i)).toMatchObject({ ok: false, retryable: true, halt: false });
      expect(outcome.ok ? '' : outcome.code, String(i)).not.toBe('GIVEN_UP');
      expect(await s.world.store.getRow(ID), String(i)).toMatchObject({ state: 'failed', attempts: i });
      const next = s.uploader.retryAt(ID);
      expect(next, String(i)).not.toBeNull();
      const delay = (next ?? 0) - s.clock.now();
      expect(delay, String(i)).toBeGreaterThanOrEqual(previous);
      expect(delay, String(i)).toBeLessThanOrEqual(3_600_000);
      previous = delay;
      delays.push(delay);
    }
    expect(delays[0]).toBe(15_000);
    expect(delays.slice(-5)).toEqual([3_600_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000]);
    // Still retried after the cap interval, and a success ends it.
    s.clock.set(s.uploader.retryAt(ID) ?? 0);
    s.world.engine.mintOverride = null;
    s.plugin.defaultBehavior = { kind: 'complete' };
    await expect(s.uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: true });
  });

  it('a transient failure is held until its backoff has passed even after twenty failures, then goes again', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(503);
    for (let i = 0; i < FAILURES; i += 1) {
      s.clock.set(s.uploader.retryAt(ID) ?? s.clock.now());
      await s.uploader.uploadDetailed(ref());
    }
    const calls = s.world.engine.http.calls.length;
    await expect(s.uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: false, code: 'SERVER', retryable: true });
    expect(s.world.engine.http.calls.length).toBe(calls);
    s.clock.advance(3_600_000);
    await s.uploader.uploadDetailed(ref());
    expect(s.world.engine.http.calls.length).toBe(calls + 1);
  });

  it('the attempt count survives a restart and keeps the backoff growing without ever reaching the given-up marker', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'failed', { attempts: MAX_UPLOAD_ATTEMPTS - 1 });
    s.world.engine.mintOverride = () => response(503);
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, retryable: true });
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS - 1 });
    expect((s.uploader.retryAt(ID) ?? 0) - s.clock.now()).toBe(3_600_000);
  });

  it('a row with many recorded attempts but not given up is still uploaded after a restart', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'failed', { attempts: 500 });
    await expect(s.uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: true });
  });

  it('a server Retry-After longer than the computed backoff wins; a shorter one never shortens it', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(429, undefined, { retryAfterMs: 1_000 });
    await s.uploader.uploadDetailed(ref());
    expect((s.uploader.retryAt(ID) ?? 0) - s.clock.now()).toBe(15_000);
    s.clock.set(s.uploader.retryAt(ID) ?? 0);
    s.world.engine.mintOverride = () => response(429, undefined, { retryAfterMs: 200_000 });
    await s.uploader.uploadDetailed(ref());
    expect((s.uploader.retryAt(ID) ?? 0) - s.clock.now()).toBe(200_000);
  });

  it('transientBackoffMs: 15 s doubling to one hour, jittered between half and full, never below a longer Retry-After', () => {
    const full = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40].map((attempt) => transientBackoffMs(attempt, null, () => 1));
    expect(full).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000]);
    expect(transientBackoffMs(1, null, () => 0)).toBe(7_500);
    expect(transientBackoffMs(30, null, () => 0)).toBe(1_800_000);
    expect(transientBackoffMs(Number.MAX_SAFE_INTEGER, null, () => 1)).toBe(3_600_000);
    expect(transientBackoffMs(1, 100_000, () => 1)).toBe(100_000);
    expect(transientBackoffMs(1, null, () => 0.5)).toBe(11_250);
  });

  it('control: a permanent refusal still uses every attempt at once and is never retried', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.engine.mintOverride = () => response(422);
    await s.uploader.uploadDetailed(ref());
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
    s.clock.advance(100 * 3_600_000);
    await s.uploader.uploadDetailed(ref());
    expect(s.world.engine.http.calls).toHaveLength(1);
  });

  it('control: a halting failure (signed out, locked) records nothing and leaves the row as it was', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.state.token = null;
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'AUTH', halt: true });
    s.state.token = 'access-token-secret';
    s.state.locked = true;
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'LOCKED', halt: true });
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(s.uploader.retryAt(ID)).toBeNull();
  });
});

describe('native uploader: a transient stat error is not a missing file (I-4)', () => {
  it('a stat that fails for another reason is retryable, mints nothing, and the row is not marked permanently failed', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.world.files.failExistsFor(`media/${ID}.jpg`);
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, code: 'FILE', retryable: true });
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(s.world.files.paths()).toContain(`media/${ID}.jpg`);
  });

  it('positive control: a confirmed not-found is the permanent FILE failure', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.files.remove(`media/${ID}.jpg`);
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'FILE', retryable: false });
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
  });
});

describe('native uploader: attempts count recorded failures only (c)', () => {
  it('starting an upload does not use an attempt; a recorded failure does', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'hang' };
    const done = s.uploader.uploadDetailed(ref());
    await s.plugin.whenStarted(1);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'uploading', attempts: 0 });
    s.plugin.emit({ name: 'failed', id: 'up-1', eventId: 'e1', payload: {} });
    await done;
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('ten interrupted starts (the process killed each time) do not fail a good photo', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID));
    const tokens = { getAccessToken: () => Promise.resolve('t'), checkSession: () => Promise.resolve(SESSION_OK) };
    for (let i = 0; i < 10; i += 1) {
      const plugin = createFakePlugin({ engine: world.engine, files: world.files, idPrefix: `dead${String(i)}` });
      plugin.defaultBehavior = { kind: 'hang' };
      const uploader = createNativeUploader({ isBlocked: neverBlocked, store: world.store, http: world.engine.http, tokens, plugin, origin: ORIGIN, isLocked: () => false, clientHeaders: {}, timers: createManualTimers() });
      void uploader.uploadDetailed(ref());
      await plugin.whenStarted(1);
      expect(await world.store.getRow(ID)).toMatchObject({ state: 'uploading', attempts: 0 });
    }
    const plugin = createFakePlugin({ engine: world.engine, files: world.files });
    const uploader = createNativeUploader({ isBlocked: neverBlocked, store: world.store, http: world.engine.http, tokens, plugin, origin: ORIGIN, isLocked: () => false, clientHeaders: {}, timers: createManualTimers() });
    await expect(uploader.uploadDetailed(ref())).resolves.toMatchObject({ ok: true });
  });
});

describe('native uploader: the client headers cannot carry credentials (a)', () => {
  it('Authorization, Cookie and Proxy-Authorization are dropped whatever their case; the rest is kept', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID));
    const plugin = createFakePlugin({ engine: world.engine, files: world.files });
    const headers = { 'X-Client-Platform': 'android', authorization: 'Bearer leak', COOKIE: 'a=b', 'Proxy-Authorization': 'x', ' Authorization ': 'y', 'X-Client-Version': '1' };
    const uploader = createNativeUploader({ isBlocked: neverBlocked,
      store: world.store, http: world.engine.http, tokens: { getAccessToken: () => Promise.resolve('t'), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin, origin: ORIGIN, isLocked: () => false, clientHeaders: headers, timers: createManualTimers(),
    });
    await uploader.uploadDetailed(ref());
    expect(plugin.starts[0]?.headers).toEqual({ 'X-Client-Platform': 'android', 'X-Client-Version': '1' });
    expect(Object.keys(headers)).toHaveLength(6);
  });
});

describe('native uploader: client headers other than credentials are passed through unchanged', () => {
  it('a caller-supplied Content-Type or Idempotency-Key is not a credential and is kept, exactly as before', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID));
    const plugin = createFakePlugin({ engine: world.engine, files: world.files });
    const headers = { 'X-Client-Platform': 'android', 'Content-Type': 'image/jpeg', 'Idempotency-Key': 'k-1' };
    const uploader = createNativeUploader({ isBlocked: neverBlocked,
      store: world.store, http: world.engine.http, tokens: { getAccessToken: () => Promise.resolve('t'), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin, origin: ORIGIN, isLocked: () => false, clientHeaders: headers, timers: createManualTimers(),
    });
    await uploader.uploadDetailed(ref());
    expect(plugin.starts[0]?.headers).toEqual(headers);
  });
});

describe('native uploader: an uploaded key is checked again before it is reused (d)', () => {
  it("a stored key that is not this photo's own is not reused: the photo is uploaded again", async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'uploaded', { uploadedKey: 'other-tenant/inspections/other/photos/stolen.jpg' });
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toEqual({ ok: true, key: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg`, reused: false });
    expect(s.plugin.starts).toHaveLength(1);
  });

  it("positive control: the photo's own stored key is reused with nothing sent", async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'uploaded', { uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg` });
    await expect(s.uploader.uploadDetailed(ref())).resolves.toEqual({ ok: true, key: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg`, reused: true });
    expect(s.plugin.starts).toHaveLength(0);
  });
});

describe('native uploader: a halt after the row was marked uploading puts it back (a3)', () => {
  const minted = (n: number) =>
    response(200, {
      success: true,
      data: { url: `/api/public/uploads/photo?token=payload000${String(n)}.signature000${String(n)}`, key: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg`, expiresAt: 9_999_999_999_999 },
    });

  it('a 401 on the upload, then a second mint whose session needs a new login: the row is back to pending, not stranded in uploading', async () => {
    const s = await setup({ session: { kind: 'relogin' } });
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: 401 };
    let mints = 0;
    s.world.engine.mintOverride = (_req, n) => {
      mints = n;
      return n === 1 ? minted(1) : response(401);
    };
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(mints).toBe(2);
    expect(outcome).toMatchObject({ ok: false, code: 'AUTH', halt: true });
    expect(s.plugin.starts).toHaveLength(1);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(s.uploader.retryAt(ID)).toBeNull();
  });

  it('a 426 on the second mint: a row that was failed with three attempts goes back to failed with three, not uploading', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'failed', { attempts: 3 });
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: 401 };
    s.world.engine.mintOverride = (_req, n) => (n === 1 ? minted(1) : response(426));
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, code: 'UPGRADE', halt: true });
    expect(s.plugin.starts).toHaveLength(1);
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: 3 });
  });

  it('signing out between the first upload and its fresh mint (no token any more) also restores the row', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: 403 };
    s.world.engine.mintOverride = () => minted(1);
    const start = s.plugin.startUpload.bind(s.plugin);
    s.plugin.startUpload = async (options) => {
      const started = await start(options);
      s.state.token = null;
      return started;
    };
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'AUTH', halt: true });
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe('native uploader: retry() is one atomic transition (f)', () => {
  function retryUploader(world: MediaWorld, extra: Partial<NativeUploaderDeps>) {
    return createNativeUploader({ isBlocked: neverBlocked,
      store: world.store,
      http: world.engine.http,
      tokens: { getAccessToken: () => Promise.resolve('t'), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin: createFakePlugin({ engine: world.engine, files: world.files }),
      origin: ORIGIN,
      isLocked: () => false,
      clientHeaders: {},
      timers: createManualTimers(),
      ...extra,
    });
  }

  it('a row that became uploaded between the read and the update is left alone and retry() answers false', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'failed', { attempts: MAX_UPLOAD_ATTEMPTS });
    const realGet = s.world.store.getRow.bind(s.world.store);
    const key = `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg`;
    s.world.store.getRow = async (id) => {
      const row = await realGet(id);
      await s.world.store.markState(id, 'uploaded', { attempts: 2, uploadedKey: key });
      return row;
    };
    await expect(s.uploader.retry(ID)).resolves.toBe(false);
    s.world.store.getRow = realGet;
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'uploaded', attempts: 2, uploadedKey: key });
  });

  it('a row that changed to another non-uploaded state in between is not overwritten either', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.world.store.markState(ID, 'failed', { attempts: 4 });
    const realGet = s.world.store.getRow.bind(s.world.store);
    s.world.store.getRow = async (id) => {
      const row = await realGet(id);
      await s.world.store.markState(id, 'uploading', { attempts: 4 });
      return row;
    };
    await expect(s.uploader.retry(ID)).resolves.toBe(false);
    s.world.store.getRow = realGet;
    expect(await s.world.store.getRow(ID)).toMatchObject({ state: 'uploading', attempts: 4 });
  });

  it('calls onRetry after a successful transition, and not after a refusal', async () => {
    const world = await createMediaWorld();
    const seen: string[] = [];
    const uploader = retryUploader(world, {
      onRetry: (pendingId) => {
        seen.push(pendingId);
      },
    });
    await world.store.put(photoRecord(ID));
    await world.store.markState(ID, 'failed', { attempts: MAX_UPLOAD_ATTEMPTS });
    await expect(uploader.retry(ID)).resolves.toBe(true);
    expect(seen).toEqual([ID]);
    await expect(uploader.retry('nobody')).resolves.toBe(false);
    await world.store.markState(ID, 'uploaded', { attempts: 0, uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/${ID}.jpg` });
    await expect(uploader.retry(ID)).resolves.toBe(false);
    expect(seen).toEqual([ID]);
  });

  it('a throwing onRetry hook does not undo or fail the retry', async () => {
    const world = await createMediaWorld();
    const uploader = retryUploader(world, {
      onRetry: () => {
        throw new Error('listener failed');
      },
    });
    await world.store.put(photoRecord(ID));
    await world.store.markState(ID, 'failed', { attempts: 5 });
    await expect(uploader.retry(ID)).resolves.toBe(true);
    expect(await world.store.getRow(ID)).toMatchObject({ state: 'pending', attempts: 0 });
  });
});
