import { unzipSync } from 'fflate';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { collectPlan } from './collect';
import { buildPackage } from './build-package';
import { ALICE, BOB, SECRETS, createExportWorld, jpegBytes, localDoc, readPackage, seedInspection, type ExportWorld } from './test-support/world';
import { ALLOWED_ENTRY, mediaIndexViolations, manifestViolations, outboxViolations, reportIdViolations } from './test-support/engine-contract';

const IDENTITY = { tenantId: ALICE.tenantId, userId: ALICE.userId };

async function build(world: ExportWorld, options: { includeQuarantined?: boolean; only?: string[] } = {}): Promise<{ bytes: Uint8Array; missing: number; photos: number }> {
  const plan = await collectPlan(world.db, IDENTITY, { includeQuarantined: options.includeQuarantined ?? false, only: options.only });
  const built = buildPackage(plan, { db: world.db, files: world.files, exportedAt: '2026-10-26T12:00:00.000Z' });
  const parts: Uint8Array[] = [];
  for await (const chunk of built.chunks) parts.push(chunk);
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, missing: built.summary().photosMissing, photos: built.summary().photosIncluded };
}

function manifestOf(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(unzipSync(bytes)['manifest.json'])) as Record<string, unknown>;
}

describe('the package the engine accepts', () => {
  it('writes a manifest that passes the engine schema, from the verified identity and the device', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { writes: ['update'], reportId: 'report-insp-1' });
    const { bytes } = await build(world);
    const manifest = manifestOf(bytes);
    expect(manifestViolations(manifest)).toEqual([]);
    expect(manifest).toMatchObject({ format: 'openinspection-offline-package', version: 1, tenantId: 'tenant-1', deviceId: 'device-1', exportedBy: 'alice', exportedAt: '2026-10-26T12:00:00.000Z', inspections: [{ id: 'insp-1', reportId: 'report-insp-1' }] });
  });

  it('contains only entry names the engine allows, and nothing else', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { writes: ['update'], photos: [{ pendingId: 'p1' }, { pendingId: 'p2', type: 'image/png' }, { pendingId: 'p3', type: 'image/heic' }] });
    await seedInspection(world, 'insp-2');
    const { bytes } = await build(world);
    const names = Object.keys(unzipSync(bytes));
    expect(names.sort()).toEqual(['manifest.json', 'media/index.json', 'media/p1.jpg', 'media/p2.png', 'media/p3.heic', 'outbox.json', 'yjs/insp-1.bin', 'yjs/insp-2.bin']);
    expect(names.filter((name) => !ALLOWED_ENTRY.test(name))).toEqual([]);
    expect(ALLOWED_ENTRY.test('extra/notes.txt')).toBe(false);
  });

  it('stores the merged Yjs state of the local document: applied to an empty document it equals the local one', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { edits: 5 });
    await seedInspection(world, 'insp-2', { edits: 1 });
    const { bytes } = await build(world);
    const entries = unzipSync(bytes);
    for (const id of ['insp-1', 'insp-2']) {
      const local = await localDoc(world, id);
      const applied = new Y.Doc();
      Y.applyUpdate(applied, entries[`yjs/${id}.bin`]!);
      expect(applied.getMap('results').toJSON()).toEqual(local.getMap('results').toJSON());
      expect(Y.encodeStateAsUpdate(applied)).toEqual(Y.encodeStateAsUpdate(local));
    }
    // Control: the states differ between inspections, so the equality above is not vacuous.
    expect(entries['yjs/insp-1.bin']).not.toEqual(entries['yjs/insp-2.bin']);
  });

  it('merges several stored updates, including concurrent ones from two clients, into one state', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { edits: 0 });
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getMap('results').set('x', 1);
    b.getMap('results').set('y', 2);
    for (const update of [Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b)]) await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-insp-1', update]);
    const { bytes } = await build(world);
    const applied = new Y.Doc();
    Y.applyUpdate(applied, unzipSync(bytes)['yjs/insp-1.bin']!);
    expect(applied.getMap('results').toJSON()).toEqual({ x: 1, y: 2 });
  });

  it('indexes every photo one to one with its file, in the engine shape', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { photos: [{ pendingId: 'p1' }, { pendingId: 'p2', type: 'image/png' }] });
    await seedInspection(world, 'insp-2', { photos: [{ pendingId: 'p3', type: 'image/heic' }] });
    const { bytes } = await build(world);
    const entries = unzipSync(bytes);
    const index = JSON.parse(new TextDecoder().decode(entries['media/index.json'])) as { pendingId: string; inspectionId: string; contentType: string }[];
    expect(mediaIndexViolations(index)).toEqual([]);
    expect(index.map((row) => `${row.pendingId}:${row.inspectionId}:${row.contentType}`).sort()).toEqual(['p1:insp-1:image/jpeg', 'p2:insp-1:image/png', 'p3:insp-2:image/heic']);
    const files = Object.keys(entries).filter((name) => name.startsWith('media/') && name !== 'media/index.json');
    expect(files.sort()).toEqual(['media/p1.jpg', 'media/p2.png', 'media/p3.heic']);
    expect(mediaIndexViolations([...index, index[0]])).toContain('duplicate pending id');
  });

  it('stores photos as they are: the bytes match, and the entry is stored, not deflated', async () => {
    const world = await createExportWorld();
    const jpeg = jpegBytes(5000);
    const png = new Uint8Array(3000).fill(9);
    await seedInspection(world, 'insp-1', { photos: [{ pendingId: 'p1', bytes: jpeg }, { pendingId: 'p2', type: 'image/png', bytes: png }, { pendingId: 'p3', type: 'image/heic', bytes: new Uint8Array(2000).fill(3) }] });
    const { bytes } = await build(world);
    const methods = new Map<string, number>();
    const entries = unzipSync(bytes, {
      filter: (file) => {
        methods.set(file.name, file.compression);
        return true;
      },
    });
    expect(entries['media/p1.jpg']).toEqual(jpeg);
    expect(entries['media/p2.png']).toEqual(png);
    expect(methods.get('media/p1.jpg')).toBe(0);
    expect(methods.get('media/p2.png')).toBe(0);
    expect(methods.get('media/p3.heic')).toBe(0);
    // Control: the JSON entries are deflated, so "0" above is the builder's choice and not how every entry looks.
    expect(methods.get('manifest.json')).toBe(8);
    expect(methods.get('yjs/insp-1.bin')).toBe(8);
  });

  it('writes the queued writes in the engine envelope: update and complete name the inspection as payload.id', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { confirmed: false, writes: ['create', 'update', 'complete'] });
    const { bytes } = await build(world);
    const outbox = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['outbox.json'])) as { idempotencyKey: string; op: string; payload: Record<string, unknown> }[];
    expect(outboxViolations(outbox)).toEqual([]);
    expect(outbox.map((entry) => entry.op)).toEqual(['inspection.create', 'inspection.update', 'inspection.complete']);
    expect(outbox[0]?.payload).toEqual({ id: 'insp-1', propertyAddress: '12 Test Street insp-1', templateId: 'template-1' });
    expect(outbox[1]?.payload).toEqual({ id: 'insp-1', propertyAddress: '14 Test Street insp-1' });
    expect(outbox[2]?.payload).toEqual({ id: 'insp-1' });
    expect(outboxViolations([{ ...outbox[0], extra: 1 }])).toContain('unknown envelope key: extra');
  });

  it('carries only the exporting account: another account on the same device contributes nothing', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'mine', { writes: ['update'] });
    await seedInspection(world, 'theirs', { owner: BOB, writes: ['update'], photos: [{ pendingId: 'bob-photo' }] });
    const { bytes } = await build(world);
    const names = Object.keys(unzipSync(bytes));
    expect(names).toContain('yjs/mine.bin');
    expect(names.filter((name) => name.includes('theirs') || name.includes('bob-photo'))).toEqual([]);
    expect(JSON.stringify(manifestOf(bytes))).not.toContain('theirs');
  });

  it('leaves out what the format cannot carry, and counts it: clips, crops and annotations', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', {
      photos: [{ pendingId: 'p1' }, { pendingId: 'clip', kind: 'video' }, { pendingId: 'crop1', kind: 'crop' }, { pendingId: 'ann1', kind: 'annotate' }],
    });
    const plan = await collectPlan(world.db, IDENTITY, { includeQuarantined: false });
    expect(plan.photos.map((photo) => photo.pendingId)).toEqual(['p1']);
    expect(plan.omitted).toMatchObject({ videos: 1, photoEdits: 1 });
  });

  it('skips a photo it cannot read, empty or over the size limit, and says how many', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { photos: [{ pendingId: 'ok' }, { pendingId: 'gone' }, { pendingId: 'empty', bytes: new Uint8Array(0) }] });
    world.files.failReadFor('media/gone.jpg');
    const { bytes, missing, photos } = await build(world);
    const index = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['media/index.json'])) as { pendingId: string }[];
    expect(index.map((row) => row.pendingId)).toEqual(['ok']);
    expect(Object.keys(unzipSync(bytes)).filter((name) => name.startsWith('media/') && name !== 'media/index.json')).toEqual(['media/ok.jpg']);
    expect(missing).toBe(2);
    expect(photos).toBe(1);
  });

  it('holds no token, refresh token, client id or device key anywhere in the package', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { confirmed: false, writes: ['create', 'update'], photos: [{ pendingId: 'p1' }] });
    const { bytes } = await build(world);
    const everything = new TextDecoder('latin1').decode(bytes);
    const entries = unzipSync(bytes);
    for (const secret of SECRETS) {
      expect(everything).not.toContain(secret);
      for (const [name, content] of Object.entries(entries)) expect(new TextDecoder('latin1').decode(content), `${name} holds ${secret}`).not.toContain(secret);
    }
    expect(JSON.stringify(manifestOf(bytes))).not.toMatch(/token|secret|password|refresh/i);
    // Control: the scan finds a secret when one is there.
    const planted = new TextDecoder('latin1').decode(new TextEncoder().encode(`xx${SECRETS[0]}yy`));
    expect(planted).toContain(SECRETS[0]);
  });

  it('writes the report id the server gave, and the importer accepts it for an inspection the server already has', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { reportId: 'report-9', writes: ['update'] });
    const { bytes } = await build(world);
    const pkg = readPackage(bytes);
    expect(pkg.manifest.inspections[0]?.reportId).toBe('report-9');
    expect(reportIdViolations(pkg.manifest, pkg.outbox, { 'insp-1': 'report-9' })).toEqual([]);
  });

  it('writes a placeholder when the report id is unknown, which the importer refuses for an inspection it has and the package does not create', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { writes: ['update'] });
    const { bytes } = await build(world);
    const pkg = readPackage(bytes);
    expect(pkg.manifest.inspections[0]?.reportId).toBe('unassigned');
    expect(manifestViolations(pkg.manifest)).toEqual([]);
    // Documented expectation, not a pass: the format is valid, and the importer still refuses the whole package here.
    expect(reportIdViolations(pkg.manifest, pkg.outbox, { 'insp-1': 'report-9' })).toEqual(['insp-1: exported from a different report']);
  });

  it('control: the same placeholder is fine for an inspection the package creates', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { confirmed: false, writes: ['create'] });
    const { bytes } = await build(world);
    const pkg = readPackage(bytes);
    expect(pkg.manifest.inspections[0]?.reportId).toBe('unassigned');
    expect(reportIdViolations(pkg.manifest, pkg.outbox, { 'insp-1': 'report-9' })).toEqual([]);
    expect(reportIdViolations({ inspections: [{ id: 'x', reportId: 'a' }] }, [], { x: 'b' })).toEqual(['x: exported from a different report']);
  });
});

describe('what goes into the package', () => {
  it('takes an inspection only when it holds something of the person: edits, queued writes or photos', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'edited', { edits: 1 });
    await seedInspection(world, 'written', { edits: 0, writes: ['complete'] });
    await seedInspection(world, 'photographed', { edits: 0, photos: [{ pendingId: 'p1' }] });
    await seedInspection(world, 'untouched', { edits: 0 });
    const plan = await collectPlan(world.db, IDENTITY, { includeQuarantined: false });
    expect(plan.inspections.map((row) => row.id).sort()).toEqual(['edited', 'photographed', 'written']);
  });

  it('leaves out an inspection that is being purged, and an id the format would refuse', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'ok-1');
    await seedInspection(world, 'going', { purging: true });
    await seedInspection(world, 'bad id with spaces');
    const plan = await collectPlan(world.db, IDENTITY, { includeQuarantined: false });
    expect(plan.inspections.map((row) => row.id)).toEqual(['ok-1']);
  });

  it('takes pending writes only: failed rows wait for a person and are not exported', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { writes: ['update'] });
    await seedInspection(world, 'b', { writes: ['update'], writeState: 'failed' });
    const plan = await collectPlan(world.db, IDENTITY, { includeQuarantined: false });
    expect(plan.outbox.map((entry) => entry.payload.id)).toEqual(['a']);
  });

  it('takes a parked write only with its quarantined inspection: on an ordinary one it means something else', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'ordinary', { writes: ['update'], writeState: 'orphaned' });
    await seedInspection(world, 'removed', { quarantined: true, writes: ['update'] });
    const without = await collectPlan(world.db, IDENTITY, { includeQuarantined: false });
    expect(without.outbox).toEqual([]);
    const withIt = await collectPlan(world.db, IDENTITY, { includeQuarantined: true });
    expect(withIt.outbox.map((entry) => entry.payload.id)).toEqual(['removed']);
  });

  it('drops a queued write it cannot express in the format and counts it', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { writes: ['update'] });
    await world.db.run("UPDATE outbox SET payload = 'not json'");
    const plan = await collectPlan(world.db, IDENTITY, { includeQuarantined: false });
    expect(plan.outbox).toEqual([]);
    expect(plan.omitted.skippedWrites).toBe(1);
  });
});
