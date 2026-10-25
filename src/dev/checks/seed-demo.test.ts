import { describe, expect, it } from 'vitest';
import { loadIdentity } from '../../auth/server-config';
import { createMediaStore } from '../../media/store';
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
});
