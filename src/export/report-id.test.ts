import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveIdentity } from '../auth/server-config';
import { resultsDocName } from '../collab/connector';
import { primaryReportIdOf, replaceInspectionResources } from '../offline/resource-cache';
import { accountKey } from '../offline/outbox';
import { createPackageWorld, envelope, jsonReply, type PackageWorld } from '../offline/test-support/package-world';
import { ALICE } from '../offline/test-support/replay-world';
import { createExporter } from './exporter';
import { createExportFiles, createFakeSharer, readPackage } from './test-support/world';
import { reportIdViolations } from './test-support/engine-contract';

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld();
});

const columnOf = async (id: string): Promise<string | null> => (await w.db.query<{ report_id: string | null }>('SELECT report_id FROM work_package WHERE inspection_id = ?', [id]))[0]?.report_id ?? null;

function serveWithReport(id: string, primaryReportId: unknown): void {
  w.serve(id);
  w.pkg.overrides.set(`/api/inspections/${id}`, () => jsonReply(200, envelope({ inspection: { id, status: 'scheduled', date: '2026-10-26T09:00:00.000Z', inspectorId: null }, ...(primaryReportId === undefined ? {} : { primaryReportId }), v: 1 })));
}

async function exportManifest(): Promise<{ manifest: ReturnType<typeof readPackage>['manifest']; outbox: ReturnType<typeof readPackage>['outbox']; reportIdUnknown: number }> {
  await saveIdentity(w.db, { userId: ALICE.userId, tenantId: ALICE.tenantId, role: 'inspector' });
  const doc = new Y.Doc();
  doc.getMap<unknown>('results').set('k', 'v');
  for (const id of (await w.db.query<{ inspection_id: string }>('SELECT inspection_id FROM work_package')).map((row) => row.inspection_id)) {
    await w.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [resultsDocName(id), Y.encodeStateAsUpdate(doc)]);
  }
  const files = createExportFiles();
  const sharer = createFakeSharer(files);
  const exporter = createExporter({ db: w.db, files, clock: w.clock, sharer, platform: 'ios' });
  const prep = await exporter.prepare();
  await exporter.run({ includeQuarantined: false, confirmed: true });
  const bytes = sharer.calls[0]?.bytes;
  if (bytes === undefined) throw new Error('Nothing was shared');
  const pkg = readPackage(bytes);
  return { manifest: pkg.manifest, outbox: pkg.outbox, reportIdUnknown: prep.reportIdUnknown };
}

describe('the report id the server sends with an inspection', () => {
  it('is stored by the refresh and written into the manifest, where the importer accepts it', async () => {
    serveWithReport('i1', 'rep-77');
    await w.seed('i1');
    expect(await columnOf('i1')).toBeNull();
    await w.run();
    expect(await columnOf('i1')).toBe('rep-77');
    const out = await exportManifest();
    expect(out.manifest.inspections).toEqual([{ id: 'i1', reportId: 'rep-77' }]);
    expect(out.reportIdUnknown).toBe(0);
    expect(reportIdViolations(out.manifest, out.outbox, { i1: 'rep-77' })).toEqual([]);
  });

  it('control: an old server that sends none leaves the column empty, the manifest carries the placeholder, and the preflight counts it', async () => {
    serveWithReport('i1', undefined);
    await w.seed('i1');
    await w.run();
    expect(await columnOf('i1')).toBeNull();
    const out = await exportManifest();
    expect(out.manifest.inspections).toEqual([{ id: 'i1', reportId: 'unassigned' }]);
    expect(out.reportIdUnknown).toBe(1);
    expect(reportIdViolations(out.manifest, out.outbox, { i1: 'rep-77' })).toEqual(['i1: exported from a different report']);
  });

  it('is never overwritten with nothing: a later answer without it keeps the stored id', async () => {
    serveWithReport('i1', 'rep-77');
    await w.seed('i1');
    await w.run();
    serveWithReport('i1', undefined);
    w.pkg.version = 2;
    await w.run();
    expect(await columnOf('i1')).toBe('rep-77');
  });

  it('is replaced when the server sends a different one', async () => {
    serveWithReport('i1', 'rep-77');
    await w.seed('i1');
    await w.run();
    serveWithReport('i1', 'rep-78');
    w.pkg.version = 2;
    await w.run();
    expect(await columnOf('i1')).toBe('rep-78');
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(129)],
    ['a number', 7],
    ['null', null],
    ['an object', { id: 'x' }],
  ])('ignores a value that is %s', async (_name, value) => {
    serveWithReport('i1', value);
    await w.seed('i1');
    await w.run();
    expect(await columnOf('i1')).toBeNull();
  });

  it('accepts exactly 128 characters', async () => {
    serveWithReport('i1', 'r'.repeat(128));
    await w.seed('i1');
    await w.run();
    expect(await columnOf('i1')).toBe('r'.repeat(128));
  });

  it('reads it only from the inspection read of that inspection, and tolerates a body that is not JSON', () => {
    expect(primaryReportIdOf(undefined)).toBeNull();
    expect(primaryReportIdOf({ body: 'not json', fetchedAt: 1 })).toBeNull();
    expect(primaryReportIdOf({ body: '{"primaryReportId":"top-level"}', fetchedAt: 1 })).toBeNull();
    expect(primaryReportIdOf({ body: '{"data":{"primaryReportId":"r1"}}', fetchedAt: 1 })).toBe('r1');
  });

  it('is written only on the row of the account, inside the same replace', async () => {
    await w.db.run("INSERT INTO work_package (inspection_id, refreshed_at, tenant_id, user_id) VALUES ('mine', 1, ?, ?)", [ALICE.tenantId, ALICE.userId]);
    await w.db.run("INSERT INTO work_package (inspection_id, refreshed_at, tenant_id, user_id) VALUES ('theirs', 1, 'tenant-1', 'bob')");
    const stage = (id: string) => new Map([[`/api/inspections/${id}`, { body: '{"data":{"primaryReportId":"rep-x"}}', fetchedAt: 1 }]]);
    expect(await replaceInspectionResources(w.db, { accountKey: accountKey(ALICE), inspectionId: 'theirs', packageGen: 0, resources: stage('theirs'), refreshedAt: 2 })).toBe('other_account');
    expect(await columnOf('theirs')).toBeNull();
    expect(await replaceInspectionResources(w.db, { accountKey: accountKey(ALICE), inspectionId: 'mine', packageGen: 0, resources: stage('mine'), refreshedAt: 2 })).toBe('replaced');
    expect(await columnOf('mine')).toBe('rep-x');
    expect(await columnOf('theirs')).toBeNull();
  });
});
