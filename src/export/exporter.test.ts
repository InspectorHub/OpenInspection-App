import { describe, expect, it } from 'vitest';
import { clientPolicy, createClientState } from '../app/client-state';
import { createMemoryKeyValue } from '../platform/kv';
import { createExporter, type Exporter, type ExporterDeps } from './exporter';
import type { ReconcileGate } from './reconcile-gate';
import { EXPORT_FILE_PATTERN } from './format';
import { createExportWorld, seedInspection, sharedPackage, snapshotTables, tableCounts, type ExportWorld } from './test-support/world';
import { manifestViolations } from './test-support/engine-contract';

function exporterFor(world: ExportWorld, extra: Partial<ExporterDeps> = {}): Exporter {
  return createExporter({ db: world.db, files: world.files, clock: world.clock, sharer: world.sharer, platform: 'ios', ...extra });
}

async function threeInspections(world: ExportWorld, quarantined: string[] = []): Promise<void> {
  for (const id of ['insp-a', 'insp-b', 'insp-c']) {
    await seedInspection(world, id, {
      quarantined: quarantined.includes(id),
      writes: ['update'],
      photos: [{ pendingId: `photo-${id}` }],
    });
  }
}

const everythingOf = (bytes: Uint8Array | undefined): string => new TextDecoder('latin1').decode(bytes);

describe('the quarantine: out by default, in only when the person opts in', () => {
  it('without the opt-in the quarantined inspection appears nowhere in the package', async () => {
    const world = await createExportWorld();
    await threeInspections(world, ['insp-b']);
    const outcome = await exporterFor(world).run({ includeQuarantined: false, confirmed: true });
    expect(outcome).toMatchObject({ kind: 'shared', inspections: 2 });
    const pkg = sharedPackage(world);
    expect(pkg.manifest.inspections.map((row) => row.id).sort()).toEqual(['insp-a', 'insp-c']);
    expect(pkg.names.filter((name) => name.includes('insp-b') || name.includes('photo-insp-b'))).toEqual([]);
    expect(pkg.media.map((row) => row.inspectionId).sort()).toEqual(['insp-a', 'insp-c']);
    expect(pkg.outbox.map((entry) => entry.payload.id).sort()).toEqual(['insp-a', 'insp-c']);
    const raw = everythingOf(world.sharer.calls[0]?.bytes);
    expect(raw).not.toContain('insp-b');
    expect(raw).not.toContain('photo-insp-b');
    expect(Object.values(pkg.entries).map((bytes) => everythingOf(bytes)).join('\n')).not.toContain('14 Test Street insp-b');
  });

  it('with the opt-in the quarantined inspection is there with its Yjs state, photos and queued writes', async () => {
    const world = await createExportWorld();
    await threeInspections(world, ['insp-b']);
    const outcome = await exporterFor(world).run({ includeQuarantined: true, confirmed: true });
    expect(outcome).toMatchObject({ kind: 'shared', inspections: 3 });
    const pkg = sharedPackage(world);
    expect(pkg.manifest.inspections.map((row) => row.id).sort()).toEqual(['insp-a', 'insp-b', 'insp-c']);
    expect(pkg.names).toContain('yjs/insp-b.bin');
    expect(pkg.names).toContain('media/photo-insp-b.jpg');
    expect(pkg.media.map((row) => row.pendingId)).toContain('photo-insp-b');
    expect(pkg.outbox.map((entry) => entry.payload.id)).toContain('insp-b');
  });

  it('control: with nothing quarantined all three are in, with or without the opt-in', async () => {
    for (const includeQuarantined of [false, true]) {
      const world = await createExportWorld();
      await threeInspections(world);
      await exporterFor(world).run({ includeQuarantined, confirmed: true });
      expect(sharedPackage(world).manifest.inspections).toHaveLength(3);
    }
  });

  it('an export of one named inspection holds that one and nothing else', async () => {
    const world = await createExportWorld();
    await threeInspections(world, ['insp-b']);
    await exporterFor(world).run({ includeQuarantined: true, only: ['insp-b'], confirmed: true });
    const pkg = sharedPackage(world);
    expect(pkg.manifest.inspections.map((row) => row.id)).toEqual(['insp-b']);
    expect(pkg.names.filter((name) => name.includes('insp-a') || name.includes('insp-c'))).toEqual([]);
  });

  it('when only quarantined inspections exist and the opt-in is off there is nothing to export, and nothing is shared or written', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-b', { quarantined: true, writes: ['update'] });
    const outcome = await exporterFor(world).run({ includeQuarantined: false, confirmed: true });
    expect(outcome).toEqual({ kind: 'nothing' });
    expect(world.sharer.calls).toEqual([]);
    expect(world.files.writtenBytes()).toBe(0);
    expect(manifestViolations({ format: 'openinspection-offline-package', version: 1, tenantId: 't', deviceId: 'd', exportedBy: 'u', exportedAt: '2026-01-01T00:00:00Z', inspections: [] })).toContain('inspections: at least one is required');
  });
});

describe('preparing: counts, company and the reconcile that runs before building', () => {
  it('asks the reconcile first, before any photo is read or any byte is written', async () => {
    const world = await createExportWorld({ company: 'Acme Inspections' });
    await threeInspections(world);
    const seen: string[] = [];
    const exporter = exporterFor(world, {
      reconcile: () => {
        seen.push(`read:${String(world.files.reads().length)} written:${String(world.files.writtenBytes())}`);
        return Promise.resolve(true);
      },
    });
    const prep = await exporter.prepare();
    expect(seen).toEqual(['read:0 written:0']);
    expect(prep).toEqual({ confirmed: true, included: 3, quarantined: 0, company: 'Acme Inspections', reportIdUnknown: 3, ids: ['insp-a', 'insp-b', 'insp-c'] });
  });

  it('counts the quarantined ones apart from the rest', async () => {
    const world = await createExportWorld();
    await threeInspections(world, ['insp-b', 'insp-c']);
    expect(await exporterFor(world, { reconcile: () => Promise.resolve(true) }).prepare()).toMatchObject({ included: 1, quarantined: 2 });
  });

  it('without a reconcile (the lock screen has none) the check is unconfirmed, and the company is null when unknown', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    expect(await exporterFor(world).prepare()).toMatchObject({ confirmed: false, included: 3, quarantined: 0, company: null });
  });

  it('a reconcile that fails or throws is unconfirmed and does not stop the export', async () => {
    for (const reconcile of [() => Promise.resolve(false), () => Promise.reject(new Error('offline'))]) {
      const world = await createExportWorld();
      await threeInspections(world);
      const exporter = exporterFor(world, { reconcile });
      expect((await exporter.prepare()).confirmed).toBe(false);
      const outcome = await exporter.run({ includeQuarantined: false, confirmed: false });
      expect(outcome).toMatchObject({ kind: 'shared', inspections: 3, unconfirmed: true });
      expect(sharedPackage(world).manifest.inspections).toHaveLength(3);
    }
  });

  it('control: a confirmed check says so in the outcome', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toMatchObject({ unconfirmed: false });
  });
});

describe('export never changes anything on the device', () => {
  it('leaves every row of every table as it was, after a shared export', async () => {
    const world = await createExportWorld();
    await threeInspections(world, ['insp-b']);
    const before = await snapshotTables(world.db);
    const counts = await tableCounts(world.db);
    await exporterFor(world, { reconcile: () => Promise.resolve(true) }).run({ includeQuarantined: true, confirmed: true });
    expect(await snapshotTables(world.db)).toEqual(before);
    expect(await tableCounts(world.db)).toEqual(counts);
    expect(Object.keys(counts)).toEqual(expect.arrayContaining(['device_state', 'work_package', 'resource_cache', 'outbox', 'media', 'ydoc_updates']));
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(10);
  });

  it('leaves every row as it was after a cancelled share, a failed share and a failed build', async () => {
    for (const how of ['cancel', 'error', 'write'] as const) {
      const world = await createExportWorld();
      await threeInspections(world);
      const before = await snapshotTables(world.db);
      if (how === 'write') world.files.failWriteAfter(10);
      else world.sharer.mode = how;
      await exporterFor(world).run({ includeQuarantined: false, confirmed: true });
      expect(await snapshotTables(world.db)).toEqual(before);
    }
  });

  it('control: the comparison does notice a change', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    const before = await snapshotTables(world.db);
    await world.db.run("UPDATE outbox SET state = 'failed'");
    expect(await snapshotTables(world.db)).not.toEqual(before);
  });

  it('works in the states that restrict everything else: upgrade required and a server that is too old', async () => {
    const state = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    state.noteUpgrade('https://oi.example.test', 'required');
    const policy = clientPolicy(state.store.get(), 'https://oi.example.test');
    expect(policy).toMatchObject({ canEdit: false, canExport: true });
    const world = await createExportWorld();
    await threeInspections(world);
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: false })).toMatchObject({ kind: 'shared', inspections: 3 });
  });

  it('works for a device whose identity is stored but whose session is gone (locked): no reconcile, everything exported', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    const outcome = await exporterFor(world).run({ includeQuarantined: false, confirmed: false });
    expect(outcome).toMatchObject({ kind: 'shared', inspections: 3, unconfirmed: true });
  });

  it('fails closed when no account is stored', async () => {
    const world = await createExportWorld({ account: null });
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: false })).toEqual({ kind: 'failed', code: 'not_signed_in' });
    expect(world.sharer.calls).toEqual([]);
  });
});

describe('preparing may change the device, running never may', () => {
  it('only the reconcile inside prepare can change state; run changes nothing even after it did', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    const reconcile: ReconcileGate = async () => {
      await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'insp-b'");
      return true;
    };
    const exporter = exporterFor(world, { reconcile });
    const before = await snapshotTables(world.db);
    const prep = await exporter.prepare();
    expect(await snapshotTables(world.db)).not.toEqual(before);
    expect(prep).toMatchObject({ included: 2, quarantined: 1 });
    const afterPrepare = await snapshotTables(world.db);
    await exporter.run({ includeQuarantined: false, confirmed: true, expected: prep.ids });
    expect(await snapshotTables(world.db)).toEqual(afterPrepare);
  });

  it('an inspection that became quarantined or purging after the question is left out and counted', async () => {
    for (const change of ["quarantine_source = 'reconcile_missing'", 'purging = 1']) {
      const world = await createExportWorld();
      await threeInspections(world);
      const exporter = exporterFor(world);
      const prep = await exporter.prepare();
      expect(prep.ids).toEqual(['insp-a', 'insp-b', 'insp-c']);
      await world.db.run(`UPDATE work_package SET ${change} WHERE inspection_id = 'insp-b'`);
      const outcome = await exporter.run({ includeQuarantined: false, confirmed: true, expected: prep.ids });
      expect(outcome).toMatchObject({ kind: 'shared', inspections: 2, changedSincePrepare: 1 });
      expect(sharedPackage(world).manifest.inspections.map((row) => row.id)).toEqual(['insp-a', 'insp-c']);
    }
  });

  it('control: nothing changed since the question counts zero', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    const exporter = exporterFor(world);
    const prep = await exporter.prepare();
    expect(await exporter.run({ includeQuarantined: false, confirmed: true, expected: prep.ids })).toMatchObject({ changedSincePrepare: 0 });
  });

  it('says so when everything the person saw is gone', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-a', { writes: ['update'] });
    const exporter = exporterFor(world);
    const prep = await exporter.prepare();
    await world.db.run('UPDATE work_package SET purging = 1');
    expect(await exporter.run({ includeQuarantined: false, confirmed: true, expected: prep.ids })).toEqual({ kind: 'nothing', changedSincePrepare: 1 });
  });
});

describe('an account the engine would refuse', () => {
  it('is refused with its own fixed code, and nothing is built or shared', async () => {
    const world = await createExportWorld({ account: { tenantId: 'tenant-1', userId: 'alice smith!' } });
    await seedInspection(world, 'insp-a', { owner: { tenantId: 'tenant-1', userId: 'alice smith!' }, writes: ['update'] });
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toEqual({ kind: 'failed', code: 'invalid_account' });
    expect(world.sharer.calls).toEqual([]);
    expect(world.files.writtenBytes()).toBe(0);
  });

  it('a tenant id outside the pattern is refused the same way', async () => {
    const world = await createExportWorld({ account: { tenantId: 'tenant/1', userId: 'alice' } });
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toEqual({ kind: 'failed', code: 'invalid_account' });
  });
});

describe('one export at a time', () => {
  it('a second export started in the same frame is refused, and the first completes once', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    const exporter = exporterFor(world);
    const first = exporter.run({ includeQuarantined: false, confirmed: true });
    const second = exporter.run({ includeQuarantined: false, confirmed: true });
    expect(await second).toEqual({ kind: 'busy' });
    expect(await first).toMatchObject({ kind: 'shared' });
    expect(world.sharer.calls).toHaveLength(1);
  });

  it('another exporter built over the same device is refused too while one runs, and the latch is released afterwards', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inShareSheet = new Promise<void>((resolve) => {
      entered = resolve;
    });
    world.sharer.during = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    const first = exporterFor(world).run({ includeQuarantined: false, confirmed: true });
    await inShareSheet;
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toEqual({ kind: 'busy' });
    release();
    await first;
    world.sharer.during = null;
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toMatchObject({ kind: 'shared' });
  });

  it('releases the latch when the export fails', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    world.sharer.mode = 'error';
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toMatchObject({ kind: 'failed' });
    world.sharer.mode = 'ok';
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toMatchObject({ kind: 'shared' });
  });
});

describe('the file that holds customer data does not outlive the share sheet', () => {
  it('is in the cache while the share sheet is open and gone after it returns', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    let during: string[] = [];
    world.sharer.during = () => {
      during = world.files.cacheNames();
    };
    await exporterFor(world).run({ includeQuarantined: false, confirmed: true });
    expect(during).toHaveLength(1);
    expect(during[0]).toMatch(EXPORT_FILE_PATTERN);
    expect(world.sharer.calls[0]?.bytes?.length).toBeGreaterThan(100);
    expect(world.files.cacheNames()).toEqual([]);
  });

  it('is removed after a cancel, and the outcome says it was cancelled', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    world.sharer.mode = 'cancel';
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toMatchObject({ kind: 'cancelled' });
    expect(world.files.cacheNames()).toEqual([]);
  });

  it('is removed after a share error, which is reported as a failure', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    world.sharer.mode = 'error';
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toEqual({ kind: 'failed', code: 'share_failed' });
    expect(world.files.cacheNames()).toEqual([]);
  });

  it('leaves no partial file when the build stops half way', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    world.files.failWriteAfter(50);
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toEqual({ kind: 'failed', code: 'build_failed' });
    expect(world.files.cacheNames()).toEqual([]);
    expect(world.sharer.calls).toEqual([]);
  });

  it('touches no other file in the cache, before or after', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    world.files.seedCache('camera-temp.jpg');
    world.files.seedCache('inspectorhub-export-notes.txt');
    world.files.seedCache('other-app.zip');
    await exporterFor(world).run({ includeQuarantined: false, confirmed: true });
    expect(world.files.cacheNames().sort()).toEqual(['camera-temp.jpg', 'inspectorhub-export-notes.txt', 'other-app.zip']);
    expect(world.files.removeCalls().filter((name) => !EXPORT_FILE_PATTERN.test(name))).toEqual([]);
  });

  it('reports a file it could not delete, so the person is told', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    world.files.failRemoveCache();
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toMatchObject({ kind: 'shared', leftover: true });
  });

  it('control: a clean delete reports no leftover', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    expect(await exporterFor(world).run({ includeQuarantined: false, confirmed: true })).toMatchObject({ leftover: false });
  });

  it('sweeps an export left behind by a crashed run when the next export starts, and only that', async () => {
    const world = await createExportWorld();
    await threeInspections(world);
    world.files.seedCache('inspectorhub-export-1700000000000.zip');
    world.files.seedCache('inspectorhub-export-1700000000001.zip');
    world.files.seedCache('keep-me.zip');
    let duringNames: string[] = [];
    world.sharer.during = () => {
      duringNames = world.files.cacheNames();
    };
    await exporterFor(world).run({ includeQuarantined: false, confirmed: true });
    expect(duringNames.filter((name) => name.startsWith('inspectorhub-export-1700'))).toEqual([]);
    expect(world.files.cacheNames()).toEqual(['keep-me.zip']);
  });

  it('names the file without any customer data: a prefix, the time and an extension', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-a', { writes: ['create'], confirmed: false });
    await exporterFor(world).run({ includeQuarantined: false, confirmed: true });
    const uri = world.sharer.calls[0]?.uri ?? '';
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    expect(name).toBe(`inspectorhub-export-${String(world.clock.now())}.zip`);
    expect(name).not.toMatch(/insp-a|Street|alice|tenant/i);
  });
});
