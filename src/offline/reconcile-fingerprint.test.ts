import { beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, fingerprints } from './reconcile-decision';
import { createReconcileWorld, seedEveryTable, seedPackages, type ReconcileWorld } from './test-support/reconcile-world';

let world: ReconcileWorld;

beforeEach(async () => {
  world = await createReconcileWorld();
});

describe('the one-inspection fingerprint equals the batch fingerprint', () => {
  it('byte for byte, for every inspection of a database whose every table holds data', async () => {
    const ids = await seedPackages(world, 6);
    await seedEveryTable(world);
    await world.outbox('p003', 'failed');
    await world.media('p003', 'pending');
    await world.ydoc('p005');
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing', pinned = 1 WHERE inspection_id = 'p006'");
    const batch = await fingerprints(world.db, new Set(ids));
    for (const id of ids) expect(await fingerprintOf(world.db, id)).toBe(batch.get(id));
    expect(new Set(ids.map((id) => batch.get(id))).size).toBeGreaterThan(3);
  });

  it('also for an inspection with no package row and no data (the empty fingerprint)', async () => {
    const batch = await fingerprints(world.db, new Set(['ghost']));
    expect(await fingerprintOf(world.db, 'ghost')).toBe(batch.get('ghost'));
    expect(batch.get('ghost')).toBe('[]');
  });

  it('moves when any one fact moves, like the batch one: queue, media, document, proof, package', async () => {
    await seedPackages(world, 4);
    await seedEveryTable(world);
    const base = await fingerprintOf(world.db, 'p001');
    await world.ydoc('p001');
    const afterDoc = await fingerprintOf(world.db, 'p001');
    expect(afterDoc).not.toBe(base);
    await world.db.run("UPDATE ydoc_sync SET updated_at = updated_at + 1 WHERE doc_name = 'results-p001'");
    const afterProof = await fingerprintOf(world.db, 'p001');
    expect(afterProof).not.toBe(afterDoc);
    await world.db.run('UPDATE work_package SET package_gen = package_gen + 1 WHERE inspection_id = ?', ['p001']);
    expect(await fingerprintOf(world.db, 'p001')).not.toBe(afterProof);
    await world.outbox('p001', 'pending');
    expect(await fingerprintOf(world.db, 'p004')).toBe((await fingerprints(world.db, new Set(['p004']))).get('p004'));
  });

  it('does not move for a change to another inspection', async () => {
    await seedPackages(world, 4);
    const before = await fingerprintOf(world.db, 'p002');
    await world.outbox('p003', 'pending');
    await world.media('p003', 'pending');
    expect(await fingerprintOf(world.db, 'p002')).toBe(before);
  });
});
