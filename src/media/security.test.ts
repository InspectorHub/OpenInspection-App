import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth/errors';
import { createManualClock } from '../platform/clock';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createNativeUploader } from './native-uploader';
import { createMediaReconciler } from './reconcile';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN, photoRecord, response } from './test-support/fakes';

const SECRET_TOKEN = 'access-token-secret';
const SESSION_OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as const;
const PENDING_PATH = /^media\/[A-Za-z0-9_-]{1,64}\.(jpg|png|heic)$/;

async function build(options: { origin?: string; allowInsecureHttp?: boolean } = {}) {
  const world = await createMediaWorld();
  const plugin = createFakePlugin({ engine: world.engine, files: world.files });
  const timers = createManualTimers();
  const state = { locked: false, token: SECRET_TOKEN as string | null };
  const errors: unknown[] = [];
  const uploader = createNativeUploader({
    store: world.store,
    http: world.engine.http,
    tokens: { getAccessToken: () => Promise.resolve(state.token), checkSession: () => Promise.resolve(SESSION_OK) },
    plugin,
    origin: options.origin ?? ORIGIN,
    ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
    isLocked: () => state.locked,
    clientHeaders: { 'X-Client-Platform': 'android' },
    timers,
    onError: (e) => errors.push(e),
  });
  return { world, plugin, timers, state, errors, uploader };
}

const ref = (pendingId = 'p1') => ({ pendingId, inspectionId: INSPECTION });
const TOKEN_QS = '?token=payload0001.signature0001';

describe('SECURITY 1: the signed url is only ever used against the pinned origin', () => {
  const good = `/api/public/uploads/photo${TOKEN_QS}`;
  const refused: [string, string][] = [
    ['a foreign host', `https://evil.example.test${good}`],
    ['a scheme-relative foreign host', `//evil.example.test${good}`],
    ['a backslash-smuggled foreign host', `/\\evil.example.test${good}`],
    ['a look-alike host', `https://oi.example.test.evil.test${good}`],
    ['a downgraded scheme', `http://oi.example.test${good}`],
    ['userinfo', `https://user:pw@oi.example.test${good}`],
    ['a foreign userinfo trick', `https://oi.example.test@evil.example.test${good}`],
    ['another port', `https://oi.example.test:8443${good}`],
    ['another path', `/api/inspections/x/media${TOKEN_QS}`],
    ['the video route', `/api/public/uploads/video${TOKEN_QS}`],
    ['a path traversal', `/api/public/uploads/../photo${TOKEN_QS}`],
    ['an extra query parameter', `${good}&redirect=https://evil.example.test`],
    ['a fragment', `${good}#x`],
    ['no token', '/api/public/uploads/photo'],
    ['a malformed token', '/api/public/uploads/photo?token=has%20space'],
    ['a javascript url', 'javascript:alert(1)'],
    ['a data url', 'data:text/plain,x'],
    ['a file url', 'file:///etc/passwd'],
    ['an empty url', ''],
    ['a very long url', `/api/public/uploads/photo?token=${'a'.repeat(5000)}.${'b'.repeat(20)}`],
  ];

  it.each(refused)('refuses %s: nothing is uploaded and the row is untouched', async (_label, url) => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.world.engine.mintOverride = () => response(200, { success: true, data: { url, key: `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`, expiresAt: 1 } });
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, code: 'BAD_URL' });
    expect(s.plugin.starts).toHaveLength(0);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it.each([
    ['a relative url', good, `${ORIGIN}${good}`],
    ['an absolute url on the pinned origin', `${ORIGIN}${good}`, `${ORIGIN}${good}`],
    ['the pinned origin with an explicit default port', `https://oi.example.test:443${good}`, `${ORIGIN}${good}`],
  ])('control: accepts %s', async (_label, url, expected) => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.plugin.defaultBehavior = { kind: 'complete', statusCode: 200 };
    s.world.engine.mintOverride = () => response(200, { success: true, data: { url, key: `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`, expiresAt: 1 } });
    expect((await s.uploader.uploadDetailed(ref())).ok).toBe(true);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.plugin.starts[0]?.serverUrl).toBe(expected);
  });

  it('refuses a key that does not belong to this inspection and photo, and never trusts it as the uploaded key', async () => {
    for (const key of [
      'tenant-1/inspections/other/photos/p1.jpg',
      `tenant-1/inspections/${INSPECTION}/photos/other.jpg`,
      `tenant-1/inspections/${INSPECTION}/photos/p1.png`,
      `../tenant-1/inspections/${INSPECTION}/photos/p1.jpg`,
      `tenant-1/inspections/${INSPECTION}/photos/../p1.jpg`,
      '',
    ]) {
      const s = await build();
      await s.world.store.put(photoRecord('p1'));
      s.world.engine.mintOverride = () => response(200, { success: true, data: { url: `/api/public/uploads/photo${TOKEN_QS}`, key, expiresAt: 1 } });
      expect(await s.uploader.uploadDetailed(ref()), key).toMatchObject({ ok: false, code: 'BAD_URL' });
      expect(s.plugin.starts).toHaveLength(0);
    }
  });

  it('a redirect from the mint call is refused and nothing is uploaded', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    const uploader = createNativeUploader({
      store: s.world.store, http: { request: () => Promise.reject(new AuthError('server_redirected')) },
      tokens: { getAccessToken: () => Promise.resolve(SECRET_TOKEN), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin: s.plugin, origin: ORIGIN, isLocked: () => false, clientHeaders: {}, timers: s.timers,
    });
    expect(await uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'BAD_URL' });
    expect(s.plugin.starts).toHaveLength(0);
    // Control: the same uploader setup with the working engine uploads.
    expect((await s.uploader.uploadDetailed(ref())).ok).toBe(true);
  });

  it('the upload request never carries the access token', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    await s.uploader.uploadDetailed(ref());
    expect(JSON.stringify(s.plugin.starts)).not.toContain(SECRET_TOKEN);
    expect(Object.keys(s.plugin.starts[0]?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
    // Control: the mint call does carry it, so the check above can fail.
    expect(JSON.stringify(s.world.engine.http.calls)).toContain(SECRET_TOKEN);
  });
});

describe('SECURITY 2 and 10: only our own file under media/ is ever addressed', () => {
  it('the path handed to the plugin and every file access is media/<id>.<ext>', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    await s.world.store.put(photoRecord('p2', { type: 'image/png' }));
    await s.world.store.put(photoRecord('p3', { type: 'image/heic' }));
    for (const id of ['p1', 'p2', 'p3']) await s.uploader.uploadDetailed(ref(id));
    expect(s.plugin.starts.map((o) => o.filePath)).toEqual(['file:///media/p1.jpg', 'file:///media/p2.png', 'file:///media/p3.heic']);
    expect(s.world.files.accessed().length).toBeGreaterThan(0);
    expect(s.world.files.accessed().every((p) => PENDING_PATH.test(p))).toBe(true);
  });

  it('a row whose path or content type was tampered with in the database is not uploaded and its path is never touched', async () => {
    const s = await build();
    const meta = JSON.stringify({ targetType: 'item', findingKey: 'k', itemId: 'i' });
    const insert = 'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)';
    await s.world.db.run(insert, ['evil-1', INSPECTION, 'photo', '../../../data/secret.db', 'image/jpeg', meta, 'pending', 0, 1]);
    await s.world.db.run(insert, ['evil-2', INSPECTION, 'photo', '/etc/passwd', 'image/jpeg', meta, 'pending', 0, 1]);
    await s.world.db.run(insert, ['evil-3', INSPECTION, 'photo', 'media/evil-3.jpg', 'text/html', meta, 'pending', 0, 1]);
    await s.world.db.run(insert, ['evil-4', INSPECTION, 'photo', 'media/other-id.jpg', 'image/jpeg', meta, 'pending', 0, 1]);
    for (const id of ['evil-1', 'evil-2', 'evil-3', 'evil-4']) {
      expect(await s.uploader.uploadDetailed(ref(id)), id).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    }
    expect(s.plugin.starts).toHaveLength(0);
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(s.world.files.accessed()).toEqual([]);
    // Control: an untampered row goes through on the same database.
    await s.world.store.put(photoRecord('fine-1'));
    expect((await s.uploader.uploadDetailed(ref('fine-1'))).ok).toBe(true);
  });
});

describe('SECURITY 3: nothing secret is logged, persisted or put into an error', () => {
  const spies = ['log', 'info', 'warn', 'error', 'debug'] as const;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a full run (success, retryable failure, permanent failure, plugin failure) writes nothing to the console and leaks nothing', async () => {
    const calls: unknown[][] = [];
    for (const name of spies) vi.spyOn(console, name).mockImplementation((...args: unknown[]) => void calls.push(args));
    const s = await build();
    for (const id of ['ok', 'err500', 'err413', 'boom']) await s.world.store.put(photoRecord(id));
    s.plugin.script = [{ kind: 'complete' }, { kind: 'complete', statusCode: 500 }, { kind: 'complete', statusCode: 413 }, { kind: 'reject' }];
    const outcomes = [];
    for (const id of ['ok', 'err500', 'err413', 'boom']) outcomes.push(await s.uploader.uploadDetailed(ref(id)));

    const everything = JSON.stringify([calls, outcomes, s.errors.map((e) => (e instanceof Error ? [e.name, e.message] : String(e)))]);
    expect(calls).toEqual([]);
    for (const needle of [SECRET_TOKEN, 'payload0', 'signature0', 'token=', '/secret/path', 'file:///', 'media/']) {
      expect(everything, needle).not.toContain(needle);
    }
    // The database holds only the key (no signed url, no token).
    const rows = JSON.stringify(await s.world.db.query('SELECT * FROM media'));
    expect(rows).not.toContain('token');
    expect(rows).not.toContain('payload0');
    expect(rows).not.toContain('/api/public');
    expect(rows).not.toContain(SECRET_TOKEN);
  });

  it('control: the console spy does see output, so the empty result above means something', () => {
    const calls: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void calls.push(args));
    console.error(`probe ${SECRET_TOKEN}`);
    expect(JSON.stringify(calls)).toContain(SECRET_TOKEN);
  });

  it('the store errors are fixed codes with fixed messages that carry no path', async () => {
    const world = await createMediaWorld();
    world.files.failWrites();
    const err: unknown = await world.store.put(photoRecord('p1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/media|\.jpg|device/i);
    expect((err as { code?: string }).code).toBe('WRITE_FAILED');
  });
});

describe('SECURITY 4: a locked, revoked or signed-out device uploads nothing and calls nothing', () => {
  it('the uploader itself refuses while locked, before any network call, and a lock check that throws counts as locked', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.state.locked = true;
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'LOCKED', halt: true });
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(s.plugin.starts).toHaveLength(0);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'pending', attempts: 0 });

    const throwing = createNativeUploader({
      store: s.world.store, http: s.world.engine.http,
      tokens: { getAccessToken: () => Promise.resolve(SECRET_TOKEN), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin: s.plugin, origin: ORIGIN, isLocked: () => Promise.reject(new Error('storage')), clientHeaders: {}, timers: s.timers,
    });
    expect(await throwing.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'LOCKED' });
    expect(s.world.engine.http.calls).toHaveLength(0);

    s.state.locked = false;
    expect((await s.uploader.uploadDetailed(ref())).ok).toBe(true);
  });

  it('a lock that arrives while the signed url is being minted stops the upload before it starts', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    const uploader = createNativeUploader({
      store: s.world.store,
      http: {
        request: (req) => {
          s.state.locked = true;
          return s.world.engine.http.request(req);
        },
      },
      tokens: { getAccessToken: () => Promise.resolve(SECRET_TOKEN), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin: s.plugin,
      origin: ORIGIN,
      isLocked: () => s.state.locked,
      clientHeaders: {},
      timers: s.timers,
    });
    expect(await uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'LOCKED' });
    expect(s.world.engine.http.calls).toHaveLength(1);
    expect(s.plugin.starts).toHaveLength(0);
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('no session token means no network call at all', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.state.token = null;
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'AUTH', halt: true });
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(s.plugin.starts).toHaveLength(0);
  });
});

describe('SECURITY 5: the same photo uploaded twice is one row, one key, one object', () => {
  it('puts twice and uploads twice: one row, one key, one stored object', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1', { seed: 1 }));
    await s.world.store.put(photoRecord('p1', { seed: 9 }));
    await s.uploader.uploadDetailed(ref());
    await s.world.store.markState('p1', 'pending', { attempts: 0, uploadedKey: null });
    await s.uploader.uploadDetailed(ref());
    expect(await s.world.db.query('SELECT * FROM media')).toHaveLength(1);
    expect(s.world.engine.objects.size).toBe(1);
    expect([...s.world.engine.objects.keys()]).toEqual([`tenant-1/inspections/${INSPECTION}/photos/p1.jpg`]);
    // The second mint produced a different token for the same key; the server overwrote.
    expect(s.world.engine.minted).toHaveLength(2);
    expect(s.world.engine.minted[0]?.url).not.toBe(s.world.engine.minted[1]?.url);
  });
});

describe('SECURITY 6: server answers become fixed errors, never server text', () => {
  it.each([[400], [411], [413], [415], [422]])('a mint answer of %i carries its body text nowhere in the outcome, the row or the errors', async (status) => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.world.engine.mintOverride = () => response(status, { error: 'SERVER-SECRET-TEXT sql: select * from users' }, { text: 'SERVER-SECRET-TEXT' });
    const outcome = await s.uploader.uploadDetailed(ref());
    expect(outcome).toMatchObject({ ok: false, code: 'REJECTED', retryable: false });
    expect(JSON.stringify([outcome, s.errors, await s.world.db.query('SELECT * FROM media')])).not.toContain('SERVER-SECRET');
    expect(s.plugin.starts).toHaveLength(0);
  });

  it.each([[429], [500], [502], [503], [504]])('a mint answer of %i is retryable', async (status) => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.world.engine.mintOverride = () => response(status, undefined, { retryAfterMs: 120_000 });
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'SERVER', retryable: true, retryAfterMs: 120_000 });
  });

  it('a 426 (client too old) halts the run without burning attempts', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.world.engine.mintOverride = () => response(426);
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'UPGRADE', halt: true, retryable: true });
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe('SECURITY 7: the file outlives the document update by construction', () => {
  it('a crash between the document update and the delete leaves the file, and the next pass finishes without uploading again', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    const order: string[] = [];
    const originalDelete = s.world.store.delete.bind(s.world.store);
    let crash = true;
    s.world.store.delete = (id) => {
      order.push('delete-attempt');
      if (crash) return Promise.reject(new Error('process killed'));
      return originalDelete(id);
    };
    const rec = createMediaReconciler({
      store: s.world.store, uploader: s.uploader,
      resolvePending: () => {
        order.push('resolve');
        return Promise.resolve('resolved');
      },
      isLocked: () => false, network: { online: () => Promise.resolve(true), onChange: () => () => undefined }, clock: createManualClock(5), timers: s.timers,
      onError: (e) => s.errors.push(e),
    });
    await rec.reconcileUploads();
    expect(order).toEqual(['resolve', 'delete-attempt']);
    expect(s.world.files.paths()).toEqual(['media/p1.jpg']);
    crash = false;
    await expect(rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.world.files.paths()).toEqual([]);
  });

  it('when the document update fails the file is never deleted, however many passes run', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    const rec = createMediaReconciler({
      store: s.world.store, uploader: s.uploader, resolvePending: () => Promise.reject(new Error('doc unavailable')),
      isLocked: () => false, network: { online: () => Promise.resolve(true), onChange: () => () => undefined }, clock: createManualClock(5), timers: s.timers,
      onError: (e) => s.errors.push(e),
    });
    for (let i = 0; i < 3; i += 1) await rec.reconcileUploads();
    expect(s.world.files.paths()).toEqual(['media/p1.jpg']);
    expect(s.world.files.removeCalls()).toEqual([]);
    expect(s.plugin.starts).toHaveLength(1);
  });
});

describe('SECURITY 8: disk-full and unreadable files never become "uploaded"', () => {
  it('a store that cannot write the file reports a fixed error and has no row', async () => {
    const world = await createMediaWorld();
    world.files.failWrites();
    await expect(world.store.put(photoRecord('p1'))).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
  });

  it('a file that cannot be checked or handed to the plugin fails retryably and is never marked uploaded', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.world.files.exists = () => Promise.reject(new Error('I/O error'));
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'FILE', retryable: true });
    expect((await s.world.store.getRow('p1'))?.state).not.toBe('uploaded');
    expect(s.plugin.starts).toHaveLength(0);
  });

  it('a plugin that cannot build its temporary body (a full disk) fails retryably, with the row failed and no key', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('p1'));
    s.plugin.defaultBehavior = { kind: 'reject' };
    expect(await s.uploader.uploadDetailed(ref())).toMatchObject({ ok: false, code: 'FILE', retryable: true });
    expect(await s.world.store.getRow('p1')).toMatchObject({ state: 'failed', uploadedKey: null });
    // Control: when the disk has room the same row uploads.
    s.plugin.defaultBehavior = { kind: 'complete' };
    expect((await s.uploader.uploadDetailed(ref())).ok).toBe(true);
  });
});

describe('SECURITY 9: hostile database content does not break the loop', () => {
  it('unknown states, oversized meta and absurd attempt counts are skipped or clamped without throwing', async () => {
    const s = await build();
    await s.world.store.put(photoRecord('good-1'));
    const insert = 'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)';
    const meta = JSON.stringify({ targetType: 'item', findingKey: 'k', itemId: 'i' });
    await s.world.db.run(insert, ['big-meta', INSPECTION, 'photo', 'media/big-meta.jpg', 'image/jpeg', JSON.stringify({ targetType: 'item', findingKey: 'x'.repeat(2_000_000), itemId: 'i' }), 'pending', 0, 1]);
    await s.world.db.run(insert, ['weird-1', INSPECTION, 'photo', 'media/weird-1.jpg', 'image/jpeg', meta, 'PENDING', 0, 1]);
    await s.world.db.run(insert, ['weird-2', INSPECTION, 'photo', 'media/weird-2.jpg', 'image/jpeg', meta, '', 0, 1]);
    await s.world.db.run(insert, ['neg-attempts', INSPECTION, 'photo', 'media/neg-attempts.jpg', 'image/jpeg', meta, 'failed', -5, 1]);
    const rec = createMediaReconciler({
      store: s.world.store, uploader: s.uploader, resolvePending: () => Promise.resolve('resolved'),
      isLocked: () => false, network: { online: () => Promise.resolve(true), onChange: () => () => undefined }, clock: createManualClock(5), timers: s.timers,
    });
    await expect(rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.plugin.starts).toHaveLength(1);
    expect(await s.world.store.getRow('good-1')).toBeNull();
    for (const id of ['big-meta', 'weird-1', 'weird-2', 'neg-attempts']) expect(await s.world.store.getRow(id), id).toBeNull();
  });
});
