import * as Y from 'yjs';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { resultsDocName } from '../collab/connector';
import { recordServerStateVector } from '../collab/sync-proof';
import { MAX_MEDIA_BYTES } from '../media/media-types';
import { buildPackage } from './build-package';
import { collectPlan } from './collect';
import { ALICE, NOW, createExportWorld, localDoc, seedInspection, type ExportWorld } from './test-support/world';

const IDENTITY = { tenantId: ALICE.tenantId, userId: ALICE.userId };

function someUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap<unknown>('results').set('k', 'v');
  return Y.encodeStateAsUpdate(doc);
}

async function bytesOf(world: ExportWorld, result: Awaited<ReturnType<typeof collectPlan>>): Promise<Uint8Array> {
  const built = buildPackage(result, { db: world.db, files: world.files, exportedAt: '2026-10-26T12:00:00.000Z' });
  const parts: Uint8Array[] = [];
  for await (const chunk of built.chunks) parts.push(chunk);
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

const plan = (world: ExportWorld, includeQuarantined = false) => collectPlan(world.db, IDENTITY, { includeQuarantined });
const ids = async (world: ExportWorld, includeQuarantined = false): Promise<string[]> => (await plan(world, includeQuarantined)).inspections.map((row) => row.id).sort();

/** Stores one more update on the device, after whatever the server was recorded to hold. */
async function editLater(world: ExportWorld, id: string): Promise<void> {
  const doc = await localDoc(world, id);
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  doc.getMap<unknown>('results').set('late', 'edit made after the server was asked');
  for (const update of updates) await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [resultsDocName(id), update]);
}

describe('leaving out what the server provably holds: documents', () => {
  it('a document the server state vector covers is left out and counted', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'covered', { edits: 3, server: 'all' });
    await seedInspection(world, 'open', { edits: 3, server: 'none' });
    const result = await plan(world);
    expect(result.inspections.map((row) => row.id)).toEqual(['open']);
    expect(result.omitted.alreadyOnServer).toBe(1);
  });

  it.each([
    ['only part of it is recorded as held', 'first'],
    ['nothing is recorded', 'none'],
  ] as const)('is exported when %s', async (_name, server) => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 3, server });
    expect(await ids(world)).toEqual(['a']);
  });

  it('is exported when an edit was stored after the server was asked', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 2, server: 'all' });
    expect(await ids(world)).toEqual([]);
    await editLater(world, 'a');
    expect(await ids(world)).toEqual(['a']);
  });

  it('is exported when a stored row cannot be read', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 2, server: 'all' });
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [resultsDocName('a'), 'not binary']);
    expect(await ids(world)).toEqual(['a']);
  });

  it('is exported when the marker is for another inspection: a marker covers only its own document', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 2, server: 'none' });
    await seedInspection(world, 'b', { edits: 2, server: 'all' });
    // b's own marker covers b only: a has none, and a marker is looked up by the document's own name.
    expect(await ids(world)).toEqual(['a']);
    await recordServerStateVector(world.db, resultsDocName('a'), Y.encodeStateVector(new Y.Doc()), NOW);
    expect(await ids(world)).toEqual(['a']);
  });

  it('is exported with a pending write even when the document is covered: a write is never hidden', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 2, server: 'all', writes: ['complete'] });
    const result = await plan(world);
    expect(result.inspections.map((row) => row.id)).toEqual(['a']);
    expect(result.omitted.alreadyOnServer).toBe(0);
  });

  it('is taken whole when it is quarantined, covered or not', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'gone', { quarantined: true, edits: 2, server: 'all' });
    expect(await ids(world)).toEqual([]);
    expect(await ids(world, true)).toEqual(['gone']);
    expect((await plan(world, true)).omitted.alreadyOnServer).toBe(0);
  });

  it('is exported when the device created the inspection: the server has not acknowledged it', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'fresh', { confirmed: false, edits: 2, server: 'all' });
    expect(await ids(world)).toEqual(['fresh']);
  });

  it('counts a document only under its own name: rows under another name hold nothing for this inspection', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 0 });
    for (const name of ['results-ab', 'xresults-a', 'results-', 'a', 'results-A']) await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [name, someUpdate()]);
    expect(await ids(world)).toEqual([]);
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [resultsDocName('a'), someUpdate()]);
    expect(await ids(world)).toEqual(['a']);
  });
});

describe('documents of a quarantined inspection are found only under its own name', () => {
  it('rows stored under another name hold nothing for it, even though a quarantined inspection is not narrowed by the proof', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { quarantined: true, edits: 0 });
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['xresults-a', someUpdate()]);
    expect(await ids(world, true)).toEqual([]);
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [resultsDocName('a'), someUpdate()]);
    expect(await ids(world, true)).toEqual(['a']);
  });
});

describe('leaving out what the server provably holds: photos', () => {
  it('an uploaded photo is not exported, a waiting one is, in the same inspection', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 0, photos: [{ pendingId: 'up', state: 'uploaded' }, { pendingId: 'wait', state: 'pending' }, { pendingId: 'bad', state: 'failed' }, { pendingId: 'busy', state: 'uploading' }] });
    expect((await plan(world)).photos.map((photo) => photo.pendingId).sort()).toEqual(['bad', 'busy', 'wait']);
  });

  it('an inspection whose only work is an uploaded photo is left out and counted', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 0, photos: [{ pendingId: 'up', state: 'uploaded' }] });
    const result = await plan(world);
    expect(result.inspections).toEqual([]);
    expect(result.omitted.alreadyOnServer).toBe(1);
  });

  it('a quarantined inspection keeps its uploaded photos when it is taken', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'gone', { quarantined: true, edits: 0, photos: [{ pendingId: 'up', state: 'uploaded' }] });
    expect((await plan(world, true)).photos.map((photo) => photo.pendingId)).toEqual(['up']);
  });
});

describe('writes the server refused', () => {
  it('are counted and never exported, and the inspection still goes when something else is unsent', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 2, writes: ['update'] });
    await seedInspection(world, 'b', { edits: 0, writes: ['complete'], writeState: 'failed' });
    await world.db.run("UPDATE outbox SET state = 'failed' WHERE inspection_id = 'b'");
    await seedInspection(world, 'c', { edits: 1, writes: ['update', 'complete'] });
    await world.db.run("UPDATE outbox SET state = 'failed' WHERE inspection_id = 'c' AND op = 'inspection.complete'");
    const result = await plan(world);
    expect(result.inspections.map((row) => row.id).sort()).toEqual(['a', 'c']);
    expect(result.omitted.failedWrites).toBe(1);
    expect(result.outbox.map((entry) => entry.op).sort()).toEqual(['inspection.update', 'inspection.update']);
  });

  it('an inspection whose creation failed leaves with everything it owns (the importer would not find it)', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'new', { confirmed: false, edits: 2, writes: ['create'], writeState: 'failed', photos: [{ pendingId: 'p1' }] });
    await seedInspection(world, 'ok', { edits: 1 });
    const result = await plan(world);
    expect(result.inspections.map((row) => row.id)).toEqual(['ok']);
    expect(result.photos).toEqual([]);
    expect(result.outbox).toEqual([]);
    expect(result.omitted.creationRefused).toBe(1);
    const names = Object.keys(unzipSync(await bytesOf(world, result)));
    expect(names.filter((name) => name.includes('new') || name.includes('p1'))).toEqual([]);
  });

  it('an inspection whose creation cannot be written leaves too', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'new', { confirmed: false, edits: 2, writes: ['create', 'update'] });
    await world.db.run("UPDATE outbox SET payload = 'damaged' WHERE op = 'inspection.create'");
    const result = await plan(world);
    expect(result.inspections).toEqual([]);
    expect(result.omitted.creationRefused).toBe(1);
  });

  it('control: a creation that is fine goes, and counts nothing', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'new', { confirmed: false, edits: 2, writes: ['create'] });
    const result = await plan(world);
    expect(result.inspections.map((row) => row.id)).toEqual(['new']);
    expect(result.omitted.creationRefused).toBe(0);
  });

  it('a refused creation of a quarantined inspection is not counted unless the quarantined are taken', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'gone', { quarantined: true, confirmed: false, edits: 1, writes: ['create'], writeState: 'failed' });
    expect((await plan(world)).omitted.creationRefused).toBe(0);
    expect((await plan(world, true)).omitted.creationRefused).toBe(1);
  });
});

describe('inspections the importer may refuse for want of a report id', () => {
  it('counts exported inspections with no known report id and no create in the package', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'unknown', { edits: 1 });
    await seedInspection(world, 'known', { edits: 1, reportId: 'report-1' });
    await seedInspection(world, 'created', { confirmed: false, edits: 1, writes: ['create'] });
    const result = await plan(world);
    expect(result.omitted.reportIdUnknown).toBe(1);
    expect(result.inspections.map((row) => row.id).sort()).toEqual(['created', 'known', 'unknown']);
  });

  it('still includes them: nothing is excluded for want of a report id', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'unknown', { edits: 1 });
    expect(await ids(world)).toEqual(['unknown']);
  });

  it('does not count one that is not exported', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'gone', { quarantined: true, edits: 1 });
    expect((await plan(world)).omitted.reportIdUnknown).toBe(0);
    expect((await plan(world, true)).omitted.reportIdUnknown).toBe(1);
  });
});

describe('counts of what stays behind', () => {
  it('count clips and edits only for inspections that are exported', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'in', { photos: [{ pendingId: 'clip1', kind: 'video' }, { pendingId: 'crop1', kind: 'crop' }] });
    await seedInspection(world, 'out', { quarantined: true, photos: [{ pendingId: 'clip2', kind: 'video' }, { pendingId: 'clip3', kind: 'video' }, { pendingId: 'crop2', kind: 'crop' }] });
    expect((await plan(world)).omitted).toMatchObject({ videos: 1, photoEdits: 1 });
    expect((await plan(world, true)).omitted).toMatchObject({ videos: 2, photoEdits: 2 });
  });
});

describe('large documents and photos', () => {
  it('writes every stored update of a document of 250 updates', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'big', { edits: 0 });
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    for (let i = 0; i < 250; i += 1) doc.getMap<unknown>('results').set(`k${String(i)}`, i);
    for (const update of updates) await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [resultsDocName('big'), update]);
    const all = await bytesOf(world, await plan(world));
    const applied = new Y.Doc();
    Y.applyUpdate(applied, unzipSync(all)['yjs/big.bin'] ?? new Uint8Array());
    expect(Object.keys(applied.getMap('results').toJSON())).toHaveLength(250);
  });

  it('skips a photo over the size the engine accepts, and counts it', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'a', { edits: 0, photos: [{ pendingId: 'fine' }, { pendingId: 'huge' }, { pendingId: 'exact' }] });
    world.files.generate('media/huge.jpg', MAX_MEDIA_BYTES + 1);
    world.files.generate('media/exact.jpg', MAX_MEDIA_BYTES);
    world.files.retain(false);
    const built = buildPackage(await plan(world), { db: world.db, files: world.files, exportedAt: '2026-10-26T12:00:00.000Z' });
    const parts: Uint8Array[] = [];
    for await (const chunk of built.chunks) parts.push(chunk);
    expect(built.summary()).toEqual({ photosIncluded: 2, photosMissing: 1 });
  });
});
