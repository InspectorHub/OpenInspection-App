import { beforeEach, describe, expect, it } from 'vitest';
import { createBlockedGuard } from '../offline/blocked';
import { enqueue } from '../offline/outbox';
import { MAX_UPLOAD_ATTEMPTS } from '../media/native-uploader';
import { createMediaWorld, defectPhotoRecord, photoRecord, type MediaWorld } from '../media/test-support/fakes';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createExecutor, type CommandDeps } from './commands';
import { MESSAGES } from './messages';
import { hasQueuedWrites, unsentPhotos } from './queued-writes';
import { scriptedApi, type ScriptedApi } from './test-support/scripted-api';
import { ALICE, seedPackage } from './test-support/seed-package';

let db: Db;
let api: ScriptedApi;
let online: boolean;
const clock = createManualClock(1000);

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    isBlocked: createBlockedGuard(db),
    isOnline: () => online,
    enqueue: (op, input) => enqueue({ db, clock }, op, input, { account: ALICE }),
    api,
    signedAtMs: () => 5000,
    hasQueuedWrites: (id) => hasQueuedWrites(db, ALICE, id),
    unsentPhotos: () => Promise.resolve('none'),
    afterWrite: () => Promise.resolve(true),
    loadScope: () => Promise.resolve({}),
    ...over,
  };
}

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
  await seedPackage(db, 'i1');
  await seedPackage(db, 'i2', { skipGlobals: true });
  api = scriptedApi();
  online = false;
});

async function worldWith(rows: (world: MediaWorld) => Promise<void>): Promise<MediaWorld> {
  const world = await createMediaWorld();
  await rows(world);
  return world;
}

const nobodyMissing = (): boolean => false;
const runWith = (world: MediaWorld, isKnownMissing: (id: string) => boolean = nobodyMissing, over: Partial<CommandDeps> = {}) =>
  createExecutor(deps({ unsentPhotos: (id) => unsentPhotos(world.store, id, isKnownMissing), ...over }))('i1', { type: 'publish' });

const WAIT = { ok: false, error: MESSAGES.publishUnsentPhotos };
const ATTENTION = { ok: false, error: MESSAGES.publishStuckPhotos };

describe('execute: publish with photos not yet on the server', () => {
  it.each(['pending', 'uploading'] as const)('refuses with the wait sentence and sends no request while an item photo is %s', async (state) => {
    online = true;
    const world = await worldWith(async (w) => {
      await w.store.put(photoRecord('p1', { inspectionId: 'i1' }));
      await w.store.markState('p1', state);
    });
    expect(await runWith(world)).toEqual(WAIT);
    expect(api.calls).toHaveLength(0);
  });

  it('a failed photo that is still being retried waits; a failed photo at the attempt limit asks for attention (two different sentences)', async () => {
    online = true;
    const retrying = await worldWith(async (w) => {
      await w.store.put(photoRecord('p1', { inspectionId: 'i1' }));
      await w.store.markState('p1', 'failed', { attempts: 3 });
    });
    expect(await runWith(retrying)).toEqual(WAIT);
    const stuck = await worldWith(async (w) => {
      await w.store.put(photoRecord('p1', { inspectionId: 'i1' }));
      await w.store.markState('p1', 'failed', { attempts: MAX_UPLOAD_ATTEMPTS });
    });
    expect(await runWith(stuck)).toEqual(ATTENTION);
    expect(MESSAGES.publishStuckPhotos).not.toBe(MESSAGES.publishUnsentPhotos);
    expect(MESSAGES.publishStuckPhotos).toMatch(/Needs attention/);
    expect(MESSAGES.publishStuckPhotos).not.toMatch(/wait/i);
    expect(MESSAGES.publishUnsentPhotos).toMatch(/wait/i);
    expect(api.calls).toHaveLength(0);
  });

  it('when both kinds exist the sentence is the one the person has to act on', async () => {
    online = true;
    const world = await worldWith(async (w) => {
      await w.store.put(photoRecord('waits', { inspectionId: 'i1', createdAt: 1 }));
      await w.store.put(photoRecord('stuck', { inspectionId: 'i1', createdAt: 2 }));
      await w.store.markState('stuck', 'failed', { attempts: MAX_UPLOAD_ATTEMPTS });
      await w.store.put(photoRecord('stuck-first', { inspectionId: 'i1', createdAt: 0 }));
    });
    expect(await runWith(world)).toEqual(ATTENTION);
    expect(api.calls).toHaveLength(0);
  });

  it('a defect photo, which has no entry in the document, blocks as well', async () => {
    online = true;
    const world = await worldWith((w) => w.store.put(defectPhotoRecord('d1', { inspectionId: 'i1' })));
    expect(await runWith(world)).toEqual(WAIT);
    expect(api.calls).toHaveLength(0);
  });

  it('an uploaded photo that is not attached yet blocks (it would be left out of the report); control: the one the reconciler found no place for does not', async () => {
    online = true;
    const world = await worldWith(async (w) => {
      await w.store.put(photoRecord('done', { inspectionId: 'i1' }));
      await w.store.markState('done', 'uploaded');
    });
    expect(await runWith(world)).toEqual(WAIT);
    expect(api.calls).toHaveLength(0);
    expect((await runWith(world, (id) => id === 'done')).ok).toBe(true);
    expect(api.calls.map((c) => c.path)).toContain('/api/inspections/i1/publish');
  });

  it('a known-missing photo does not hide a real one beside it', async () => {
    online = true;
    const world = await worldWith(async (w) => {
      await w.store.put(photoRecord('gone', { inspectionId: 'i1', createdAt: 1 }));
      await w.store.markState('gone', 'uploaded');
      await w.store.put(photoRecord('moving', { inspectionId: 'i1', createdAt: 2 }));
    });
    expect(await runWith(world, (id) => id === 'gone')).toEqual(WAIT);
    expect(api.calls).toHaveLength(0);
  });

  it('control: with no photo of this inspection the publish request is sent, also with a photo of another inspection waiting', async () => {
    online = true;
    const none = await worldWith(async () => undefined);
    expect((await runWith(none)).ok).toBe(true);
    expect(api.calls.map((c) => c.path)).toContain('/api/inspections/i1/publish');
    const other = await worldWith((w) => w.store.put(photoRecord('p-other', { inspectionId: 'i2' })));
    const before = api.calls.length;
    expect((await runWith(other)).ok).toBe(true);
    expect(api.calls.length).toBeGreaterThan(before);
  });

  it('a list that cannot be read counts as photos on their way', async () => {
    online = true;
    const broken = { listRows: () => Promise.reject(new Error('db down')) };
    expect(await unsentPhotos(broken, 'i1', nobodyMissing)).toBe('waiting');
    const world = await worldWith(async () => undefined);
    expect(await runWith(world, nobodyMissing, { unsentPhotos: (id) => unsentPhotos(broken, id, nobodyMissing) })).toEqual(WAIT);
    expect(api.calls).toHaveLength(0);
  });

  it('only a publish is held back: another command goes through while a photo waits', async () => {
    online = true;
    const world = await worldWith((w) => w.store.put(photoRecord('p1', { inspectionId: 'i1' })));
    const result = await createExecutor(deps({ unsentPhotos: (id) => unsentPhotos(world.store, id, nobodyMissing) }))('i1', { type: 'set-cover', coverPhotoId: 'photo-key' });
    expect(result.ok).toBe(true);
    expect(api.calls.length).toBeGreaterThan(0);
  });

  it('offline, the answer is still the connection one', async () => {
    const world = await worldWith((w) => w.store.put(photoRecord('p1', { inspectionId: 'i1' })));
    expect(await runWith(world)).toEqual({ ok: false, error: MESSAGES.needsConnection });
  });
});
