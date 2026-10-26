import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createBlockedGuard } from '../offline/blocked';
import { createManualClock } from '../platform/clock';
import { isMediaError } from './errors';
import { createNativeUploader, type NativeUploader } from './native-uploader';
import { createWithDoc } from './pending-doc';
import { createMediaReconciler, type MediaReconciler, type ResolvePending } from './reconcile';
import { createMediaStore } from './store';
import { sweepOrphanFiles } from './sweep';
import { sweepUploaderTempFiles, UPLOADER_TEMP_MIN_AGE_MS } from './uploader-temp';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN, photoRecord, type FakePlugin, type MediaWorld } from './test-support/fakes';

const SESSION_OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as const;
const OTHER = 'insp-2';

interface Setup {
  world: MediaWorld;
  plugin: FakePlugin;
  timers: ReturnType<typeof createManualTimers>;
  uploader: NativeUploader;
  rec: MediaReconciler;
  resolve: ReturnType<typeof vi.fn<ResolvePending>>;
  errors: unknown[];
  /** The ids the test's own guard reports as blocked. */
  blocked: Set<string>;
  guardCalls: string[];
}

interface SetupOptions {
  guard?: 'set' | 'db' | 'throws';
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const world = await createMediaWorld();
  const plugin = createFakePlugin({ engine: world.engine, files: world.files });
  const timers = createManualTimers();
  const clock = createManualClock(1_000_000);
  const errors: unknown[] = [];
  const blocked = new Set<string>();
  const guardCalls: string[] = [];
  const mode = options.guard ?? 'set';
  const isBlocked =
    mode === 'throws'
      ? () => Promise.reject(new Error('unreadable'))
      : mode === 'db'
        ? createBlockedGuard(world.db)
        : (id: string) => {
            guardCalls.push(id);
            return Promise.resolve(blocked.has(id));
          };
  const resolve = vi.fn<ResolvePending>(() => Promise.resolve('resolved'));
  const uploader = createNativeUploader({
    store: world.store,
    http: world.engine.http,
    tokens: { getAccessToken: () => Promise.resolve('access-token-secret'), checkSession: () => Promise.resolve(SESSION_OK) },
    plugin,
    origin: ORIGIN,
    isLocked: () => false,
    clientHeaders: {},
    timers,
    clock,
    random: () => 1,
    onError: (e) => errors.push(e),
    isBlocked,
  });
  const rec = createMediaReconciler({
    store: world.store,
    uploader,
    resolveDefectPhoto: () => Promise.resolve('missing'),
    resolvePending: resolve,
    isLocked: () => false,
    network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
    clock,
    timers,
    random: () => 0.5,
    onError: (e) => errors.push(e),
    isBlocked,
  });
  return { world, plugin, timers, uploader, rec, resolve, errors, blocked, guardCalls };
}

const rowState = async (s: Setup, id: string): Promise<{ state: string; attempts: number } | null> => {
  const row = await s.world.store.getRow(id);
  return row === null ? null : { state: row.state, attempts: row.attempts };
};

describe('the uploader refuses a blocked inspection', () => {
  it('starts nothing, mints nothing, and leaves the row exactly as it was', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('p1'));
    s.blocked.add(INSPECTION);
    const outcome = await s.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION });
    expect(outcome).toEqual({ ok: false, code: 'BLOCKED', retryable: true, retryAfterMs: null, halt: false });
    expect(s.plugin.starts).toEqual([]);
    expect(s.world.engine.http.calls).toEqual([]);
    expect(await rowState(s, 'p1')).toEqual({ state: 'pending', attempts: 0 });
    expect(s.uploader.retryAt('p1')).toBeNull();
    expect(s.errors).toEqual([]);
  });

  it('control: the same photo with the inspection free is uploaded', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('p1'));
    const outcome = await s.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION });
    expect(outcome.ok).toBe(true);
    expect(s.plugin.starts).toHaveLength(1);
  });

  it('fails closed: a guard that cannot answer blocks', async () => {
    const s = await setup({ guard: 'throws' });
    await s.world.store.put(photoRecord('p1'));
    const outcome = await s.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION });
    expect(outcome).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(s.plugin.starts).toEqual([]);
  });

  it('a tombstone that lands while the signed url is being minted stops the transfer before it starts', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('p1'));
    const original = s.world.engine.http.request.bind(s.world.engine.http);
    s.world.engine.http.request = async (req) => {
      const answer = await original(req);
      s.blocked.add(INSPECTION);
      return answer;
    };
    const outcome = await s.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION });
    expect(outcome).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(s.plugin.starts).toEqual([]);
    expect(await rowState(s, 'p1')).toEqual({ state: 'pending', attempts: 0 });
  });

  it('works with the real database guard: the tombstone row blocks, clearing it frees', async () => {
    const s = await setup({ guard: 'db' });
    await s.world.store.put(photoRecord('p1'));
    await s.world.db.run('INSERT INTO work_package (inspection_id, refreshed_at, purging) VALUES (?, 1, 1)', [INSPECTION]);
    expect(await s.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION })).toMatchObject({ ok: false, code: 'BLOCKED' });
    await s.world.db.run('UPDATE work_package SET purging = 0 WHERE inspection_id = ?', [INSPECTION]);
    expect((await s.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION })).ok).toBe(true);
  });

});

describe('an upload in flight when the inspection is purged', () => {
  async function hanging(s: Setup, id: string, inspectionId: string): Promise<{ done: ReturnType<NativeUploader['uploadDetailed']>; plugin: FakePlugin }> {
    await s.world.store.put(photoRecord(id, { inspectionId }));
    const done = s.uploader.uploadDetailed({ pendingId: id, inspectionId });
    return { done, plugin: s.plugin };
  }

  it('cancelFor removes the plugin upload, settles the transfer as blocked and leaves no failure record', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    const { done } = await hanging(s, 'p1', INSPECTION);
    await s.plugin.whenStarted(1);
    await s.uploader.cancelFor(INSPECTION);
    expect(await done).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(s.plugin.removed).toHaveLength(1);
    expect(s.uploader.isActive('p1')).toBe(false);
    expect(s.uploader.retryAt('p1')).toBeNull();
    expect((await rowState(s, 'p1'))?.attempts).toBe(0);
  });

  it('cancelFor only touches the uploads of that inspection', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    const a = await hanging(s, 'p1', INSPECTION);
    const b = await hanging(s, 'p2', OTHER);
    await s.plugin.whenStarted(2);
    await s.uploader.cancelFor(INSPECTION);
    expect(await a.done).toMatchObject({ code: 'BLOCKED' });
    expect(s.plugin.removed).toHaveLength(1);
    expect(s.uploader.isActive('p2')).toBe(true);
    const held = s.plugin.heldIds();
    expect(held).toHaveLength(2);
    const second = held.find((id) => !s.plugin.removed.includes(id));
    expect(second).toBeDefined();
    s.plugin.finish(second ?? '', 200);
    expect((await b.done).ok).toBe(true);
  });

  it('cancelFor with nothing in flight resolves at once', async () => {
    const s = await setup();
    await expect(s.uploader.cancelFor(INSPECTION)).resolves.toBeUndefined();
    expect(s.plugin.removed).toEqual([]);
  });

  it('a transfer that finishes after its row and file are gone neither throws nor brings the row back', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    const { done } = await hanging(s, 'p1', INSPECTION);
    await s.plugin.whenStarted(1);
    await s.world.store.delete('p1');
    expect(await s.world.store.getRow('p1')).toBeNull();
    const id = s.plugin.heldIds()[0] ?? '';
    s.plugin.finish(id, 200);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(await s.world.store.getRow('p1')).toBeNull();
    expect(await s.world.db.query('SELECT 1 FROM media')).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('a transfer that FAILS after its row is gone records nothing and does not bring the row back', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    const { done } = await hanging(s, 'p1', INSPECTION);
    await s.plugin.whenStarted(1);
    await s.world.store.delete('p1');
    const id = s.plugin.heldIds()[0] ?? '';
    s.plugin.emit({ name: 'failed', id, eventId: 'ev-x', payload: { error: 'boom', statusCode: 500 } });
    await expect(done).resolves.toMatchObject({ ok: false });
    expect(await s.world.db.query('SELECT 1 FROM media')).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});

describe('the media reconciler skips the rows of a blocked inspection', () => {
  it('leaves them untouched (not failed, not started, not counted) and processes the rest', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('a1', { inspectionId: INSPECTION, createdAt: 1 }));
    await s.world.store.put(photoRecord('b1', { inspectionId: OTHER, createdAt: 2 }));
    s.blocked.add(INSPECTION);
    const result = await s.rec.reconcileUploads();
    expect(result).toEqual({ retried: 0, confirmed: 1 });
    expect(await rowState(s, 'a1')).toEqual({ state: 'pending', attempts: 0 });
    expect(await s.world.store.getRow('b1')).toBeNull();
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.resolve).toHaveBeenCalledTimes(1);
    expect(s.world.files.paths()).toContain('media/a1.jpg');
    expect(s.timers.pending()).toBe(0);
  });

  it('control: with nothing blocked both rows are processed', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('a1', { inspectionId: INSPECTION, createdAt: 1 }));
    await s.world.store.put(photoRecord('b1', { inspectionId: OTHER, createdAt: 2 }));
    expect(await s.rec.reconcileUploads()).toEqual({ retried: 0, confirmed: 2 });
  });

  it('does not run the document step of an uploaded photo of a blocked inspection, and keeps its row and file', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('a1'));
    await s.uploader.uploadDetailed({ pendingId: 'a1', inspectionId: INSPECTION });
    expect((await rowState(s, 'a1'))?.state).toBe('uploaded');
    s.blocked.add(INSPECTION);
    await s.rec.reconcileUploads();
    expect(s.resolve).not.toHaveBeenCalled();
    expect((await rowState(s, 'a1'))?.state).toBe('uploaded');
    expect(s.world.files.paths()).toContain('media/a1.jpg');
  });

  it('touches failed and uploading rows of a blocked inspection no more than pending ones', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('f1', { createdAt: 1 }));
    await s.world.store.put(photoRecord('u1', { createdAt: 2 }));
    await s.world.store.markState('f1', 'failed', { attempts: 2 });
    await s.world.store.markState('u1', 'uploading', { attempts: 0 });
    s.blocked.add(INSPECTION);
    await s.rec.reconcileUploads();
    expect(await rowState(s, 'f1')).toEqual({ state: 'failed', attempts: 2 });
    expect(await rowState(s, 'u1')).toEqual({ state: 'uploading', attempts: 0 });
    expect(s.plugin.starts).toEqual([]);
  });

  it('asks the guard once per inspection per run, not once per row', async () => {
    const s = await setup();
    for (let i = 0; i < 4; i += 1) await s.world.store.put(photoRecord(`a${String(i)}`, { createdAt: i + 1 }));
    s.blocked.add(INSPECTION);
    s.guardCalls.length = 0;
    await s.rec.reconcileUploads();
    expect(s.guardCalls).toEqual([INSPECTION]);
  });

  it('fails closed when the guard cannot answer: nothing is started', async () => {
    const s = await setup({ guard: 'throws' });
    await s.world.store.put(photoRecord('a1'));
    await s.rec.reconcileUploads();
    expect(s.plugin.starts).toEqual([]);
    expect(await rowState(s, 'a1')).toEqual({ state: 'pending', attempts: 0 });
  });

  it('resumes the rows when the block is lifted and the reconciler is triggered', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('a1'));
    s.blocked.add(INSPECTION);
    await s.rec.reconcileUploads();
    expect(await rowState(s, 'a1')).toEqual({ state: 'pending', attempts: 0 });
    s.blocked.delete(INSPECTION);
    s.rec.trigger();
    await s.rec.idle();
    expect(await s.world.store.getRow('a1')).toBeNull();
    expect(s.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('the reconciler and the uploader each answer for themselves', () => {
  async function split(reconcilerGuard: (id: string) => Promise<boolean>) {
    const world = await createMediaWorld();
    const plugin = createFakePlugin({ engine: world.engine, files: world.files });
    const timers = createManualTimers();
    const clock = createManualClock(1_000_000);
    const resolve = vi.fn<ResolvePending>(() => Promise.resolve('resolved'));
    const uploader = createNativeUploader({
      store: world.store,
      http: world.engine.http,
      tokens: { getAccessToken: () => Promise.resolve('access-token-secret'), checkSession: () => Promise.resolve(SESSION_OK) },
      plugin,
      origin: ORIGIN,
      isLocked: () => false,
      clientHeaders: {},
      timers,
      clock,
      random: () => 1,
      isBlocked: () => Promise.resolve(true),
    });
    const rec = createMediaReconciler({
      store: world.store,
      uploader,
      resolveDefectPhoto: () => Promise.resolve('missing'),
      resolvePending: resolve,
      isLocked: () => false,
      network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
      clock,
      timers,
      random: () => 0.5,
      isBlocked: reconcilerGuard,
    });
    return { world, plugin, timers, uploader, rec, resolve };
  }

  it('a BLOCKED answer from the uploader is neither a failure nor something to wait for', async () => {
    const s = await split(() => Promise.resolve(false));
    await s.world.store.put(photoRecord('a1'));
    s.rec.start();
    await s.rec.idle();
    expect(s.timers.pending()).toBe(0);
    s.rec.stop();
    expect(s.plugin.starts).toEqual([]);
    expect(await s.world.store.getRow('a1')).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('a reconciler guard that cannot answer keeps the document step away from an uploaded photo', async () => {
    const s = await split(() => Promise.reject(new Error('unreadable')));
    await s.world.store.put(photoRecord('a1'));
    await s.world.store.markState('a1', 'uploaded', { uploadedKey: `tenant-1/inspections/${INSPECTION}/photos/a1.jpg` });
    await s.rec.reconcileUploads();
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.world.files.paths()).toContain('media/a1.jpg');
  });
});

describe('the document step refuses a blocked inspection', () => {
  async function withDocWorld(blocked: boolean) {
    const world = await createMediaWorld();
    const withDoc = createWithDoc({ db: world.db, docs: { isOpen: () => false, liveDoc: () => null }, isBlocked: () => Promise.resolve(blocked) });
    return { world, withDoc };
  }

  it('rejects with BLOCKED and writes no document row', async () => {
    const { world, withDoc } = await withDocWorld(true);
    const error = await withDoc(INSPECTION, (doc) => doc.getMap<unknown>('results').set('k', 1)).catch((e: unknown) => e);
    expect(isMediaError(error) && error.code).toBe('BLOCKED');
    expect(await world.db.query('SELECT 1 FROM ydoc_updates')).toEqual([]);
  });

  it('control: the same call with the inspection free changes the document and stores it', async () => {
    const { world, withDoc } = await withDocWorld(false);
    await withDoc(INSPECTION, (doc) => {
      doc.getMap<unknown>('results').set('k', 1);
    });
    expect((await world.db.query('SELECT 1 FROM ydoc_updates WHERE doc_name = ?', [`results-${INSPECTION}`])).length).toBeGreaterThan(0);
  });

  it('also refuses when the live document of an open editor would be changed', async () => {
    const world = await createMediaWorld();
    const live = new Y.Doc();
    const withDoc = createWithDoc({ db: world.db, docs: { isOpen: () => true, liveDoc: () => live }, isBlocked: () => Promise.resolve(true) });
    await expect(withDoc(INSPECTION, (doc) => doc.getMap<unknown>('results').set('k', 1))).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(live.getMap<unknown>('results').size).toBe(0);
  });

  it('fails closed when the guard rejects', async () => {
    const world = await createMediaWorld();
    const withDoc = createWithDoc({ db: world.db, docs: { isOpen: () => false, liveDoc: () => null }, isBlocked: () => Promise.reject(new Error('unreadable')) });
    await expect(withDoc(INSPECTION, () => 1)).rejects.toMatchObject({ code: 'BLOCKED' });
  });
});

describe('the store refuses a new photo or clip for a blocked inspection', () => {
  async function storeWorld(guard: (id: string) => Promise<boolean>) {
    const world = await createMediaWorld();
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: guard });
    return { world, store };
  }

  it('put writes neither a file nor a row, and rejects with BLOCKED', async () => {
    const { world, store } = await storeWorld(() => Promise.resolve(true));
    await expect(store.put(photoRecord('p1'))).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(world.files.paths()).toEqual([]);
    expect(await world.db.query('SELECT 1 FROM media')).toEqual([]);
  });

  it('putVideo is refused the same way, before a byte is written', async () => {
    const { world, store } = await storeWorld(() => Promise.resolve(true));
    const source = { contentType: 'video/mp4', size: 3, chunks: async function* () { yield new Uint8Array([1, 2, 3]); } };
    await expect(store.putVideo({ pendingId: 'v1', inspectionId: INSPECTION, createdAt: 1, meta: {}, source })).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(world.files.writeCalls()).toEqual([]);
    expect(await world.db.query('SELECT 1 FROM media')).toEqual([]);
  });

  it('fails closed when the guard rejects', async () => {
    const { world, store } = await storeWorld(() => Promise.reject(new Error('unreadable')));
    await expect(store.put(photoRecord('p1'))).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(world.files.writeCalls()).toEqual([]);
  });

  it('a purge that begins between the file and the row leaves neither behind', async () => {
    const answers = [false, true];
    const { world, store } = await storeWorld(() => Promise.resolve(answers.shift() ?? true));
    await expect(store.put(photoRecord('p1'))).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(world.files.paths()).toEqual([]);
    expect(await world.db.query('SELECT 1 FROM media')).toEqual([]);
  });

  it('control: the same photo for a free inspection is stored', async () => {
    const { world, store } = await storeWorld(() => Promise.resolve(false));
    await store.put(photoRecord('p1'));
    expect(world.files.paths()).toEqual(['media/p1.jpg']);
    expect((await world.db.query('SELECT 1 FROM media')).length).toBe(1);
  });
});

describe('the sweeps do not fight a purge', () => {
  const OLD = 1_000_000_000_000 + 10 * 3_600_000;

  it('sweepOrphanFiles keeps the files of rows that still exist, whatever the inspection is doing', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('p1'));
    await world.db.run('INSERT INTO work_package (inspection_id, refreshed_at, purging) VALUES (?, 1, 1)', [INSPECTION]);
    world.files.setMtime('media/p1.jpg', 1_000_000_000_000);
    const result = await sweepOrphanFiles({ db: world.db, files: world.files, clock: createManualClock(OLD) });
    expect(result).toEqual({ removed: 0, failed: 0 });
    expect(world.files.paths()).toEqual(['media/p1.jpg']);
  });

  it('control: the same old file without a row is removed', async () => {
    const world = await createMediaWorld();
    await world.files.write('media/gone.jpg', new Uint8Array([1]));
    world.files.setMtime('media/gone.jpg', 1_000_000_000_000);
    const result = await sweepOrphanFiles({ db: world.db, files: world.files, clock: createManualClock(OLD) });
    expect(result.removed).toBe(1);
  });

  it('sweepOrphanFiles after a finished purge finds nothing, and writes nothing back', async () => {
    const world = await createMediaWorld();
    const before = await world.db.query('SELECT * FROM media');
    const result = await sweepOrphanFiles({ db: world.db, files: world.files, clock: createManualClock(OLD) });
    expect(result).toEqual({ removed: 0, failed: 0 });
    expect(await world.db.query('SELECT * FROM media')).toEqual(before);
  });

  it('sweepUploaderTempFiles does nothing while a row of a purging inspection is still uploading, and removes the copy once it is gone', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('p1'));
    await world.store.markState('p1', 'uploading');
    await world.db.run('INSERT INTO work_package (inspection_id, refreshed_at, purging) VALUES (?, 1, 1)', [INSPECTION]);
    world.files.seedCache('upload-123456.tmp', 1_000_000_000_000);
    const clock = createManualClock(1_000_000_000_000 + UPLOADER_TEMP_MIN_AGE_MS + 1);
    const during = await sweepUploaderTempFiles({ db: world.db, files: world.files, clock, isUploading: () => Promise.resolve(false) });
    expect(during.skipped).toBe('uploads_active');
    expect(world.files.cacheNames()).toEqual(['upload-123456.tmp']);
    await world.store.delete('p1');
    const after = await sweepUploaderTempFiles({ db: world.db, files: world.files, clock, isUploading: () => Promise.resolve(false) });
    expect(after.removed).toEqual(['upload-123456.tmp']);
  });
});

describe('a cancel that is asked for while the plugin is still starting the upload', () => {
  it('catches it when it registers: the plugin upload is dropped and the transfer settles as blocked', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('p1'));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begun: () => void = () => undefined;
    const begins = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const start = s.plugin.startUpload.bind(s.plugin);
    s.plugin.startUpload = async (options) => {
      begun();
      await gate;
      return start(options);
    };
    s.plugin.defaultBehavior = { kind: 'hang' };
    const done = s.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION });
    await begins;
    const cancelled = s.uploader.cancelFor(INSPECTION);
    release();
    expect(await done).toMatchObject({ ok: false, code: 'BLOCKED' });
    await cancelled;
    expect(s.plugin.removed).toHaveLength(1);
    expect(s.uploader.isActive('p1')).toBe(false);
  });
});
