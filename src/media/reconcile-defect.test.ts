import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { defectPhotosOf, seedDefects } from '../field/test-support/doc-seed';
import { fakeAppState } from '../offline/test-support/fakes';
import { createManualClock } from '../platform/clock';
import { MediaError } from './errors';
import { createNativeUploader } from './native-uploader';
import { appendPendingInDoc } from './pending-doc-append';
import { createDefectResolver, createPendingResolver, type WithDoc } from './pending-doc';
import { createMediaReconciler, MISSING_RECHECK_BASE_MS, type ResolveDefectPhoto, type ResolvePending } from './reconcile';
import { createFakePlugin, createMediaWorld, defectPhotoRecord, INSPECTION, ORIGIN, photoRecord } from './test-support/fakes';

const SESSION_OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as const;
const FK = '_default:s1:i1';
const OTHER = 'insp-2';
const keyFor = (pendingId: string, inspectionId = INSPECTION): string => `tenant-1/inspections/${inspectionId}/photos/${pendingId}.jpg`;

/** The real store, uploader, document steps and reconciler over one shared document, with switches for what goes wrong. */
async function setup(options: { isOtherAccount?: (inspectionId: string) => Promise<boolean> } = {}) {
  const world = await createMediaWorld();
  const plugin = createFakePlugin({ engine: world.engine, files: world.files });
  const timers = createManualTimers();
  const clock = createManualClock(1_000_000);
  const doc = new Y.Doc();
  seedDefects(doc, FK, { canned: [{ id: 'd1' }], custom: [{ id: 'd1' }, { id: 'd2' }] });
  const flags = { blocked: new Set<string>(), docBlocked: false, docFailure: null as unknown, locked: false };
  const errors: unknown[] = [];
  const withDoc: WithDoc = (inspectionId, fn) => {
    if (flags.docBlocked) return Promise.reject(new MediaError('BLOCKED'));
    if (flags.docFailure !== null) return Promise.reject(flags.docFailure);
    void inspectionId;
    return Promise.resolve(fn(doc));
  };
  const resolveItem = vi.fn<ResolvePending>(createPendingResolver({ withDoc }));
  const resolveDefect = vi.fn<ResolveDefectPhoto>(createDefectResolver({ withDoc }));
  let rec: ReturnType<typeof createMediaReconciler> | null = null;
  const uploader = createNativeUploader({
    isBlocked: (id) => Promise.resolve(flags.blocked.has(id)),
    store: world.store,
    http: world.engine.http,
    tokens: { getAccessToken: () => Promise.resolve('access-token'), checkSession: () => Promise.resolve(SESSION_OK) },
    plugin,
    origin: ORIGIN,
    isLocked: () => flags.locked,
    clientHeaders: {},
    timers,
    clock,
    random: () => 1,
    onRetry: () => rec?.trigger(),
  });
  rec = createMediaReconciler({
    isBlocked: (id) => Promise.resolve(flags.blocked.has(id)),
    store: world.store,
    uploader,
    resolvePending: resolveItem,
    resolveDefectPhoto: resolveDefect,
    ...(options.isOtherAccount === undefined ? {} : { isOtherAccount: options.isOtherAccount }),
    isLocked: () => flags.locked,
    network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
    appState: fakeAppState(),
    clock,
    timers,
    random: () => 0.5,
    onError: (error) => errors.push(error),
  });
  return { world, plugin, timers, clock, doc, flags, errors, resolveItem, resolveDefect, rec };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const rowStates = async (s: Setup): Promise<[string, string][]> => (await s.world.store.listRows()).map((r) => [r.pendingId, r.state]);

describe('the reconciler finishes a defect photo by attaching its key to the defect', () => {
  it('uploads it, adds { key } to the canned defect, then removes the row and the file (control: an item photo beside it goes through the item step)', async () => {
    const s = await setup();
    await s.world.store.put(defectPhotoRecord('dp-1', { customId: 'd1', defectKind: 'canned', createdAt: 1 }));
    await s.world.store.put(photoRecord('ip-1', { createdAt: 2 }));
    appendPendingInDoc(s.doc, FK, 'i1', 'ip-1');
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 2 });
    expect(defectPhotosOf(s.doc, FK, 'canned', 'd1')).toEqual([{ key: keyFor('dp-1') }]);
    expect(defectPhotosOf(s.doc, FK, 'custom', 'd1')).toBeUndefined();
    expect(s.resolveDefect).toHaveBeenCalledTimes(1);
    expect(s.resolveDefect).toHaveBeenCalledWith(INSPECTION, 'dp-1', keyFor('dp-1'), { findingKey: FK, itemId: 'i1', customId: 'd1', defectKind: 'canned' });
    expect(s.resolveItem).toHaveBeenCalledTimes(1);
    expect(s.resolveItem).toHaveBeenCalledWith(INSPECTION, 'ip-1', keyFor('ip-1'));
    expect(s.world.engine.objects.has(keyFor('dp-1'))).toBe(true);
    expect(await rowStates(s)).toEqual([]);
    expect(s.world.files.paths()).toEqual([]);
  });

  it('attaches to a custom defect when the row names a custom one', async () => {
    const s = await setup();
    await s.world.store.put(defectPhotoRecord('dp-1', { customId: 'd2', defectKind: 'custom' }));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(defectPhotosOf(s.doc, FK, 'custom', 'd2')).toEqual([{ key: keyFor('dp-1') }]);
    expect(defectPhotosOf(s.doc, FK, 'custom', 'd1')).toBeUndefined();
    expect(defectPhotosOf(s.doc, FK, 'canned', 'd1')).toBeUndefined();
  });

  it('a key the document already holds is not added again and the row is still removed', async () => {
    const s = await setup();
    await s.world.store.put(defectPhotoRecord('dp-1', { customId: 'd1', defectKind: 'canned' }));
    seedDefects(s.doc, FK, { canned: [{ id: 'd1', photos: [{ key: keyFor('dp-1') }] }], custom: [{ id: 'd1' }] });
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(defectPhotosOf(s.doc, FK, 'canned', 'd1')).toEqual([{ key: keyFor('dp-1') }]);
    expect(await rowStates(s)).toEqual([]);
  });

  it('a defect that is not in the document keeps the file and the row, asks again on the growing wait, never uploads twice, and never deletes on its own', async () => {
    const s = await setup();
    await s.world.store.put(defectPhotoRecord('dp-1', { customId: 'gone', defectKind: 'custom' }));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(await rowStates(s)).toEqual([['dp-1', 'uploaded']]);
    expect(s.world.files.paths()).toEqual(['media/dp-1.jpg']);
    expect(s.rec.countUnreferenced()).toBe(1);

    // Before the wait has passed the document is not even read again.
    const callsBefore = s.resolveDefect.mock.calls.length;
    await s.rec.reconcileUploads();
    expect(s.resolveDefect.mock.calls.length).toBe(callsBefore);

    s.clock.advance(MISSING_RECHECK_BASE_MS + 1);
    await s.rec.reconcileUploads();
    expect(s.resolveDefect.mock.calls.length).toBe(callsBefore + 1);
    expect(await rowStates(s)).toEqual([['dp-1', 'uploaded']]);
    expect(s.plugin.starts).toHaveLength(1);

    // The wait doubled: one base wait later it is still not asked.
    s.clock.advance(MISSING_RECHECK_BASE_MS + 1);
    await s.rec.reconcileUploads();
    expect(s.resolveDefect.mock.calls.length).toBe(callsBefore + 1);

    // A restored version brings the defect back: the next look attaches the photo and only then removes it.
    seedDefects(s.doc, FK, { canned: [{ id: 'd1' }], custom: [{ id: 'gone' }] });
    s.clock.advance(MISSING_RECHECK_BASE_MS * 2);
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(defectPhotosOf(s.doc, FK, 'custom', 'gone')).toEqual([{ key: keyFor('dp-1') }]);
    expect(await rowStates(s)).toEqual([]);
    expect(s.plugin.starts).toHaveLength(1);
  });

  it('a document step that fails keeps the file and the row and retries only the document step (no second upload)', async () => {
    const s = await setup();
    await s.world.store.put(defectPhotoRecord('dp-1', { customId: 'd1', defectKind: 'canned' }));
    s.flags.docFailure = new MediaError('DOC_BUSY');
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(await rowStates(s)).toEqual([['dp-1', 'uploaded']]);
    expect(defectPhotosOf(s.doc, FK, 'canned', 'd1')).toBeUndefined();
    expect(s.errors).toHaveLength(1);

    s.flags.docFailure = null;
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(s.plugin.starts).toHaveLength(1);
    expect(defectPhotosOf(s.doc, FK, 'canned', 'd1')).toEqual([{ key: keyFor('dp-1') }]);
  });

  it('a block that begins between the upload and the document step writes nothing and costs the row nothing (control: unblocked, the same row is attached)', async () => {
    const s = await setup();
    await s.world.store.put(defectPhotoRecord('dp-1', { customId: 'd1', defectKind: 'canned' }));
    s.flags.docBlocked = true;
    await s.rec.reconcileUploads();
    expect(await rowStates(s)).toEqual([['dp-1', 'uploaded']]);
    expect(defectPhotosOf(s.doc, FK, 'canned', 'd1')).toBeUndefined();
    expect(s.errors).toEqual([]);

    s.flags.docBlocked = false;
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(defectPhotosOf(s.doc, FK, 'canned', 'd1')).toEqual([{ key: keyFor('dp-1') }]);
  });

  it('a blocked inspection\'s defect row is neither uploaded nor attached (control: the inspection beside it is)', async () => {
    const s = await setup();
    s.flags.blocked.add(INSPECTION);
    await s.world.store.put(defectPhotoRecord('dp-1', { customId: 'd1', defectKind: 'canned' }));
    await s.world.store.put(defectPhotoRecord('dp-2', { inspectionId: OTHER, customId: 'd1', defectKind: 'canned' }));
    await s.rec.reconcileUploads();
    expect(await rowStates(s)).toEqual([['dp-1', 'pending']]);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.resolveDefect).toHaveBeenCalledTimes(1);
    expect(s.resolveDefect.mock.calls[0]?.[0]).toBe(OTHER);
  });
});

describe('the reconciler leaves the rows of another account alone', () => {
  it('does not upload, attach, count or fail a row of another account\'s package (control: an own row is finished)', async () => {
    const asked: string[] = [];
    const s = await setup({
      isOtherAccount: (id) => {
        asked.push(id);
        return Promise.resolve(id === OTHER);
      },
    });
    await s.world.store.put(defectPhotoRecord('own-d', { customId: 'd1', defectKind: 'canned', createdAt: 1 }));
    await s.world.store.put(defectPhotoRecord('foreign-d', { inspectionId: OTHER, customId: 'd1', defectKind: 'canned', createdAt: 2 }));
    await s.world.store.put(photoRecord('foreign-i', { inspectionId: OTHER, createdAt: 3 }));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(await rowStates(s)).toEqual([
      ['foreign-d', 'pending'],
      ['foreign-i', 'pending'],
    ]);
    expect((await s.world.store.getRow('foreign-d'))?.attempts).toBe(0);
    expect(s.plugin.starts).toHaveLength(1);
    expect(s.world.files.paths().sort()).toEqual(['media/foreign-d.jpg', 'media/foreign-i.jpg']);
    // Asked once per inspection per run, however many rows it has.
    expect(asked.filter((id) => id === OTHER)).toHaveLength(1);
    expect(asked.filter((id) => id === INSPECTION)).toHaveLength(1);
  });

  it('a guard that cannot answer counts as another account: the row is untouched, the failure is reported, and the next run does the work', async () => {
    let broken = true;
    const s = await setup({ isOtherAccount: () => (broken ? Promise.reject(new Error('db')) : Promise.resolve(false)) });
    await s.world.store.put(defectPhotoRecord('dp-1', { customId: 'd1', defectKind: 'canned' }));
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 0 });
    expect(await rowStates(s)).toEqual([['dp-1', 'pending']]);
    expect(s.plugin.starts).toHaveLength(0);
    expect(s.errors).toHaveLength(1);
    broken = false;
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
    expect(await rowStates(s)).toEqual([]);
  });

  it('with no owner guard every row is this account\'s', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord('ip-1', { inspectionId: OTHER }));
    appendPendingInDoc(s.doc, FK, 'i1', 'ip-1');
    await expect(s.rec.reconcileUploads()).resolves.toEqual({ retried: 0, confirmed: 1 });
  });
});
