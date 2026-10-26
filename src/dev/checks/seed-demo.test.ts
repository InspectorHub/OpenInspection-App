import { describe, expect, it } from 'vitest';
import { defectTargetOf } from '../../media/defect-target';
import { createDefectResolver, createPendingResolver, createWithDoc } from '../../media/pending-doc';
import { createMediaReconciler, type MediaReconciler } from '../../media/reconcile';
import { MAX_UPLOAD_ATTEMPTS } from '../../media/native-uploader';
import { loadIdentity } from '../../auth/server-config';
import { createMediaStore, type MediaStore } from '../../media/store';
import { listUnattributableOutbox } from '../../offline/user-actions';
import { readWorkListSnapshot, type SnapshotSource } from '../../ui/worklist/model';
import { createDiagRig, type DiagRig } from '../test-support';
import { clearDemo, seedDemo, seedDemoClear } from './seed-demo';

async function sourceOf(rig: DiagRig): Promise<SnapshotSource> {
  const { db } = rig.services;
  const identity = await loadIdentity(db);
  if (identity === null) throw new Error('the rig is not signed in');
  const account = { tenantId: identity.tenantId, userId: identity.userId };
  return {
    db,
    account,
    store: createMediaStore({ db, files: rig.world.files, isBlocked: () => Promise.resolve(false) }),
    userActions: { listUnattributableOutbox: () => listUnattributableOutbox(db, account) },
    reconciler: { last: { status: 'never', reason: null, at: null, massSuspicious: false, allMissing: false, candidateCount: 0, unavailableRole: false, refusedNullInspectionId: false, counts: null, resumed: 0, resumeFailed: false } },
    lastPlan: () => null,
  };
}

function storeOf(rig: DiagRig): MediaStore {
  return createMediaStore({ db: rig.services.db, files: rig.world.files, isBlocked: () => Promise.resolve(false) });
}

/** The real document steps over the device's stored documents, with an uploader that has nothing to send: only the uploaded rows matter here. */
function reconcilerOf(rig: DiagRig, store: MediaStore): MediaReconciler {
  const { db, clock } = rig.services;
  const withDoc = createWithDoc({ db, docs: { isOpen: () => false, liveDoc: () => null }, isBlocked: () => Promise.resolve(false), onError: () => undefined });
  return createMediaReconciler({
    store,
    uploader: { uploadDetailed: () => Promise.reject(new Error('the seed has nothing to upload')), attach: () => Promise.resolve(), isActive: () => false, retryAt: () => null, forgetExcept: () => undefined, handlesVideo: () => false },
    resolvePending: createPendingResolver({ withDoc }),
    resolveDefectPhoto: createDefectResolver({ withDoc }),
    isLocked: () => false,
    network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
    clock,
    isBlocked: () => Promise.resolve(false),
  });
}

describe('seed-demo', () => {
  it('needs a signed-in device', async () => {
    const rig = await createDiagRig({ signedIn: false });
    expect(await seedDemo.run(rig.ctx)).toMatchObject({ status: 'needs_sign_in', ok: false });
    expect((await rig.services.db.query('SELECT 1 FROM work_package')).length).toBe(0);
  });

  it('puts every state of the work list on the device, all under the diag- prefix', async () => {
    const rig = await createDiagRig({ signedIn: true });
    const result = await seedDemo.run(rig.ctx);
    expect(result).toMatchObject({ id: 'seed-demo', ok: true, status: 'pass' });
    const snap = await readWorkListSnapshot(await sourceOf(rig), rig.services.clock.now());
    expect(snap.rows.length).toBeGreaterThanOrEqual(8);
    for (const row of snap.rows) expect(row.id.startsWith('diag-')).toBe(true);
    const some = (test: (r: (typeof snap.rows)[number]) => boolean): boolean => snap.rows.some(test);
    expect(some((r) => r.downloaded && r.blocked === 'none' && !r.pinned)).toBe(true);
    expect(some((r) => r.pinned && r.blocked === 'none')).toBe(true);
    expect(some((r) => !r.downloaded)).toBe(true);
    expect(some((r) => r.waiting > 0)).toBe(true);
    expect(some((r) => r.needAttention > 0 && r.blocked === 'none')).toBe(true);
    expect(some((r) => r.lastError !== null)).toBe(true);
    expect(some((r) => r.createdLocally)).toBe(true);
    expect(some((r) => r.blocked === 'quarantined' && !r.pinned)).toBe(true);
    expect(some((r) => r.blocked === 'quarantined' && r.pinned)).toBe(true);
    expect(some((r) => r.blocked === 'purging')).toBe(true);
    expect(some((r) => r.orphaned > 0)).toBe(true);
    expect(new Set(snap.rows.map((r) => r.group)).size).toBeGreaterThanOrEqual(4);
    expect(snap.failedOutbox.length).toBeGreaterThan(0);
    expect(snap.failedMedia.length).toBeGreaterThan(0);
    expect(snap.repair.rows.length).toBeGreaterThan(0);
  });

  it('queues nothing the replayer could send: every waiting write is held for a year', async () => {
    const rig = await createDiagRig({ signedIn: true });
    await seedDemo.run(rig.ctx);
    const now = rig.services.clock.now();
    const rows = await rig.services.db.query<{ next_at: number | null }>("SELECT next_at FROM outbox WHERE state = 'pending'");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.next_at ?? 0).toBeGreaterThan(now + 300 * 86_400_000);
  });

  it('can be run twice without duplicating anything', async () => {
    const rig = await createDiagRig({ signedIn: true });
    await seedDemo.run(rig.ctx);
    const first = (await rig.services.db.query('SELECT 1 FROM work_package')).length;
    await seedDemo.run(rig.ctx);
    expect((await rig.services.db.query('SELECT 1 FROM work_package')).length).toBe(first);
  });

  it('clearing removes only the demo rows', async () => {
    const rig = await createDiagRig({ signedIn: true });
    const { db } = rig.services;
    await db.run('INSERT INTO work_package (inspection_id, refreshed_at) VALUES (?, ?)', ['real-1', 1]);
    await db.run('INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id) VALUES (?, ?, ?, ?, ?, ?, ?)', ['real-key', 9999, 'inspection.update', '{}', 'pending', 1, 'real-1']);
    await seedDemo.run(rig.ctx);
    const cleared = await seedDemoClear.run(rig.ctx);
    expect(cleared).toMatchObject({ id: 'seed-demo-clear', ok: true });
    for (const [table, column] of [['work_package', 'inspection_id'], ['outbox', 'inspection_id'], ['media', 'inspection_id'], ['resource_cache', 'package_id']] as const) {
      const left = await db.query<{ v: string | null }>(`SELECT ${column} AS v FROM ${table}`);
      expect(left.filter((r) => r.v !== null && r.v.startsWith('diag-'))).toEqual([]);
    }
    expect((await db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['real-1'])).length).toBe(1);
    expect((await db.query('SELECT 1 FROM outbox WHERE idempotency_key = ?', ['real-key'])).length).toBe(1);
    expect((await db.query("SELECT 1 FROM outbox WHERE idempotency_key LIKE 'diag-%'")).length).toBe(0);
    expect(clearDemo).toBeTypeOf('function');
  });

  it('seeds a defect photo at the attempt limit on an own, unblocked inspection, so the panel offers to discard it while an item photo at the limit only retries', async () => {
    const rig = await createDiagRig({ signedIn: true });
    await seedDemo.run(rig.ctx);
    const snap = await readWorkListSnapshot(await sourceOf(rig), rig.services.clock.now());
    const defects = snap.failedMedia.filter((m) => m.target === 'defect');
    expect(defects.map((m) => m.pendingId).sort()).toEqual(['diag-photo-defect-canned', 'diag-photo-defect-custom']);
    const row = snap.rows.find((r) => r.id === 'diag-failed');
    expect(row).toMatchObject({ blocked: 'none' });
    expect(row?.needAttention).toBeGreaterThanOrEqual(3);
    expect(snap.failedMedia.find((m) => m.pendingId === 'diag-photo-failed')).toMatchObject({ target: 'item', inspectionId: 'diag-failed' });
    for (const m of defects) expect(m.inspectionId).toBe('diag-failed');
    const store = storeOf(rig);
    const kinds: string[] = [];
    for (const m of defects) {
      const stored = await store.getRow(m.pendingId);
      expect(stored).toMatchObject({ state: 'failed', attempts: MAX_UPLOAD_ATTEMPTS });
      const target = stored === null ? null : defectTargetOf(stored);
      expect(target).not.toBeNull();
      kinds.push(target?.defectKind ?? 'none');
    }
    expect(kinds.sort()).toEqual(['canned', 'custom']);
  });

  it('seeds an uploaded photo whose defect is not in the stored document: a recheck counts it as unreferenced and removal takes it off the device', async () => {
    const rig = await createDiagRig({ signedIn: true });
    await seedDemo.run(rig.ctx);
    const store = storeOf(rig);
    const uploaded = await store.listRows({ states: ['uploaded'] });
    expect(uploaded.map((r) => r.pendingId)).toEqual(['diag-photo-unattached']);
    expect(uploaded[0]?.uploadedKey).not.toBeNull();
    const reconciler = reconcilerOf(rig, store);
    reconciler.recheckMissing();
    await reconciler.idle();
    expect(reconciler.countUnreferenced()).toBe(1);
    expect(reconciler.isUnreferenced('diag-photo-unattached')).toBe(true);
    expect(await store.getRow('diag-photo-unattached')).not.toBeNull();
    expect(await reconciler.removeUnreferenced()).toEqual({ removed: 1, attached: 0, skipped: 0 });
    expect(await store.getRow('diag-photo-unattached')).toBeNull();
  });

  it('control: an uploaded photo whose defect IS in the stored document is attached and removed, and is not counted', async () => {
    const rig = await createDiagRig({ signedIn: true });
    await seedDemo.run(rig.ctx);
    const { db } = rig.services;
    const store = storeOf(rig);
    const seeded = await store.getRow('diag-photo-unattached');
    if (seeded === null || seeded.uploadedKey === null) throw new Error('the seed wrote no uploaded photo');
    const present = seeded.uploadedKey.replace('diag-photo-unattached', 'diag-photo-present');
    const meta = JSON.stringify({ targetType: 'defect', findingKey: '_default:s1:i1', itemId: 'i1', customId: 'diag-defect-present', defectKind: 'canned' });
    await db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, uploaded_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['diag-photo-present', seeded.inspectionId, 'photo', 'media/diag-photo-present.jpg', 'image/jpeg', meta, 'uploaded', 0, present, 1]);
    const reconciler = reconcilerOf(rig, store);
    reconciler.recheckMissing();
    await reconciler.idle();
    expect(await store.getRow('diag-photo-present')).toBeNull();
    expect(reconciler.isUnreferenced('diag-photo-present')).toBe(false);
    expect(reconciler.countUnreferenced()).toBe(1);
    expect(reconciler.isUnreferenced('diag-photo-unattached')).toBe(true);
  });

  it('clearing also removes the stored demo document, and leaves the document of another inspection alone', async () => {
    const rig = await createDiagRig({ signedIn: true });
    const { db } = rig.services;
    await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-real-1', new Uint8Array([0, 0])]);
    await seedDemo.run(rig.ctx);
    expect((await db.query("SELECT 1 FROM ydoc_updates WHERE doc_name = 'results-diag-today'")).length).toBeGreaterThan(0);
    await seedDemoClear.run(rig.ctx);
    expect((await db.query("SELECT 1 FROM ydoc_updates WHERE doc_name = 'results-diag-today'")).length).toBe(0);
    expect((await db.query("SELECT 1 FROM ydoc_updates WHERE doc_name = 'results-real-1'")).length).toBe(1);
  });
});
