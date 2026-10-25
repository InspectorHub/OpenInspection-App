import { describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { isMediaError } from './errors';
import { createMediaStore } from './store';
import { createMediaWorld, INSPECTION, photoRecord } from './test-support/fakes';
import { videoRecord } from './test-support/video-fakes';
import type { MediaWorld } from './test-support/fakes';

/**
 * A guard that answers `false` every time but runs `onCall` first on the n-th call: the way a test lands a tombstone
 * transaction in the gap between the store's guard check and its row insert.
 */
function guardWithGap(nth: number, onCall: () => Promise<void>): () => Promise<boolean> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === nth) await onCall();
    return false;
  };
}

const tombstone = (world: MediaWorld) => async (): Promise<void> => {
  await world.db.run('INSERT INTO work_package (inspection_id, refreshed_at, purging) VALUES (?, 1, 1)', [INSPECTION]);
};

const quarantine = (world: MediaWorld) => async (): Promise<void> => {
  await world.db.run("INSERT INTO work_package (inspection_id, refreshed_at, quarantine_source) VALUES (?, 1, 'reconcile_missing')", [INSPECTION]);
};

const mediaCount = async (world: MediaWorld): Promise<number> => Number((await world.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM media'))[0]?.n);

describe('the media row is inserted atomically with the block check', () => {
  it('a tombstone landing between the guard check and the insert refuses the photo and leaves no file and no row', async () => {
    const world = await createMediaWorld();
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: guardWithGap(2, tombstone(world)) });
    const error = await store.put(photoRecord('p1')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isMediaError(error) && error.code).toBe('BLOCKED');
    expect(await mediaCount(world)).toBe(0);
    expect(world.files.paths()).toEqual([]);
  });

  it('a quarantine landing in that gap refuses it as well', async () => {
    const world = await createMediaWorld();
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: guardWithGap(2, quarantine(world)) });
    await expect(store.put(photoRecord('p1'))).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(await mediaCount(world)).toBe(0);
    expect(world.files.paths()).toEqual([]);
  });

  it('control: the same gap with nothing landing in it stores the photo', async () => {
    const world = await createMediaWorld();
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: guardWithGap(2, () => Promise.resolve()) });
    await store.put(photoRecord('p1'));
    expect(await mediaCount(world)).toBe(1);
    expect(world.files.paths()).toEqual(['media/p1.jpg']);
  });

  it('control: a package row that is neither tombstoned nor quarantined does not refuse', async () => {
    const world = await createMediaWorld();
    await world.db.run('INSERT INTO work_package (inspection_id, refreshed_at) VALUES (?, 1)', [INSPECTION]);
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: () => Promise.resolve(false) });
    await store.put(photoRecord('p1'));
    expect(await mediaCount(world)).toBe(1);
  });

  it('a block on ANOTHER inspection does not refuse this one', async () => {
    const world = await createMediaWorld();
    await world.db.run('INSERT INTO work_package (inspection_id, refreshed_at, purging) VALUES (?, 1, 1)', ['insp-other']);
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: () => Promise.resolve(false) });
    await store.put(photoRecord('p1'));
    expect(await mediaCount(world)).toBe(1);
  });

  it('a clip: a tombstone landing between the clip copy and the row insert refuses it and removes the file', async () => {
    const world = await createMediaWorld();
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: guardWithGap(2, tombstone(world)) });
    await expect(store.putVideo(videoRecord('v1'))).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(await mediaCount(world)).toBe(0);
    expect(world.files.paths()).toEqual([]);
  });

  it('a clip: control, nothing landing in the gap stores it', async () => {
    const world = await createMediaWorld();
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: guardWithGap(2, () => Promise.resolve()) });
    await store.putVideo(videoRecord('v1'));
    expect(await mediaCount(world)).toBe(1);
    expect(world.files.paths()).toEqual(['media/v1.mp4']);
  });

  it('a repeated put of an id that has a row stays silent and keeps the first file', async () => {
    const world = await createMediaWorld();
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: () => Promise.resolve(false) });
    await store.put(photoRecord('p1', { seed: 1 }));
    const first = world.files.bytes('media/p1.jpg');
    await store.put(photoRecord('p1', { seed: 2 }));
    expect(await mediaCount(world)).toBe(1);
    expect(world.files.bytes('media/p1.jpg')).toEqual(first);
  });
});

describe('the second guard check of a put (after the file is written)', () => {
  it('a guard that turns to blocked after the file was written refuses the photo and removes the file', async () => {
    const world = await createMediaWorld();
    let calls = 0;
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: () => Promise.resolve((calls += 1) >= 2) });
    await expect(store.put(photoRecord('p1'))).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(await mediaCount(world)).toBe(0);
    expect(world.files.paths()).toEqual([]);
  });

  it('the same for a clip: the check between the clip copy and the row insert', async () => {
    const world = await createMediaWorld();
    let calls = 0;
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: () => Promise.resolve((calls += 1) >= 2) });
    await expect(store.putVideo(videoRecord('v1'))).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(await mediaCount(world)).toBe(0);
    expect(world.files.paths()).toEqual([]);
  });
});

describe('an insert that changed nothing: a repeated id is told from a refusal by reading the row', () => {
  it('a row for the SAME id that lands in the guard gap keeps the existing row and its file, and the put stays silent', async () => {
    const world = await createMediaWorld();
    const other = createMediaStore({ db: world.db, files: world.files, isBlocked: () => Promise.resolve(false) });
    const store = createMediaStore({ db: world.db, files: world.files, isBlocked: guardWithGap(2, () => other.put(photoRecord('p1', { seed: 1 }))) });
    await store.put(photoRecord('p1', { seed: 1 }));
    expect(await mediaCount(world)).toBe(1);
    expect(world.files.paths()).toEqual(['media/p1.jpg']);
  });

  it('a read of the row that fails cannot tell a repeat from a refusal: the file is KEPT and the put fails with DB_FAILED', async () => {
    const world = await createMediaWorld();
    let armed = false;
    let reads = 0;
    const db: Db = {
      execute: (sql) => world.db.execute(sql),
      query: (sql, params) => {
        if (armed && /FROM media WHERE pending_id = \?/.test(sql)) {
          reads += 1;
          return Promise.reject(new Error('injected read failure'));
        }
        return world.db.query(sql, params);
      },
      run: (sql, params) => world.db.run(sql, params),
      transaction: (fn) => world.db.transaction(fn),
    };
    // A tombstone lands in the gap, so the insert changes nothing and the store has to read the row to know why.
    const store = createMediaStore({
      db,
      files: world.files,
      isBlocked: guardWithGap(2, async () => {
        await tombstone(world)();
        armed = true;
      }),
    });
    const error = await store.put(photoRecord('p1')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isMediaError(error) && error.code).toBe('DB_FAILED');
    expect(reads).toBe(1);
    expect(world.files.paths()).toEqual(['media/p1.jpg']);
    expect(await mediaCount(world)).toBe(0);
  });
});
