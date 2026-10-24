import { describe, expect, it } from 'vitest';
import { createManualClock } from '../platform/clock';
import { ORPHAN_MIN_AGE_MS, sweepOrphanFiles } from './sweep';
import { createMediaWorld, INSPECTION, jpegBytes, photoRecord } from './test-support/fakes';

/** A plausible wall-clock instant in milliseconds (2027); mtimes below 1e12 are treated as unknown by the sweep. */
const NOW = 1_800_000_000_000;

describe('sweepOrphanFiles: files in media/ that no row refers to', () => {
  it('removes an old orphan and keeps files that have a row, files that are recent, files with an unknown age and foreign names', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(NOW);
    await world.store.put(photoRecord('has-row'));
    world.files.setMtime('media/has-row.jpg', NOW - 10 * ORPHAN_MIN_AGE_MS);

    await world.files.write('media/old-orphan.jpg', jpegBytes());
    world.files.setMtime('media/old-orphan.jpg', NOW - ORPHAN_MIN_AGE_MS - 1);
    await world.files.write('media/recent-orphan.png', jpegBytes());
    world.files.setMtime('media/recent-orphan.png', NOW - ORPHAN_MIN_AGE_MS + 1);
    await world.files.write('media/unknown-age.heic', jpegBytes());
    world.files.setMtime('media/unknown-age.heic', null);
    await world.files.write('media/notes.txt', jpegBytes());
    world.files.setMtime('media/notes.txt', 0);
    await world.files.write('elsewhere/old.jpg', jpegBytes());
    world.files.setMtime('elsewhere/old.jpg', 0);

    const result = await sweepOrphanFiles({ db: world.db, files: world.files, clock });
    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(world.files.paths().sort()).toEqual(
      ['elsewhere/old.jpg', 'media/has-row.jpg', 'media/notes.txt', 'media/recent-orphan.png', 'media/unknown-age.heic'].sort(),
    );
    expect(await world.store.getRow('has-row')).not.toBeNull();
  });

  it('exactly one hour old is still kept (the boundary), and a second sweep removes nothing more', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(NOW);
    await world.files.write('media/edge.jpg', jpegBytes());
    world.files.setMtime('media/edge.jpg', NOW - ORPHAN_MIN_AGE_MS);
    expect(await sweepOrphanFiles({ db: world.db, files: world.files, clock })).toEqual({ removed: 0, failed: 0 });
    clock.advance(1);
    expect(await sweepOrphanFiles({ db: world.db, files: world.files, clock })).toEqual({ removed: 1, failed: 0 });
    expect(await sweepOrphanFiles({ db: world.db, files: world.files, clock })).toEqual({ removed: 0, failed: 0 });
  });

  it('a row that is corrupt but present still protects its file; a failed removal is counted, not thrown', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(NOW);
    const meta = JSON.stringify({ targetType: 'item', findingKey: 'k', itemId: 'i' });
    await world.db.run(
      'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ['odd', INSPECTION, 'photo', 'media/odd.jpg', 'image/jpeg', meta, 'exploded', 0, 1],
    );
    await world.files.write('media/odd.jpg', jpegBytes());
    world.files.setMtime('media/odd.jpg', NOW - 10 * ORPHAN_MIN_AGE_MS);
    await world.files.write('media/stuck.jpg', jpegBytes());
    world.files.setMtime('media/stuck.jpg', NOW - 10 * ORPHAN_MIN_AGE_MS);
    world.files.failRemoveFor('media/stuck.jpg');
    expect(await sweepOrphanFiles({ db: world.db, files: world.files, clock })).toEqual({ removed: 0, failed: 1 });
    expect(world.files.paths().sort()).toEqual(['media/odd.jpg', 'media/stuck.jpg']);
  });

  it('a directory that does not exist yet sweeps to nothing, and another listing failure is thrown', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(NOW);
    expect(await sweepOrphanFiles({ db: world.db, files: world.files, clock })).toEqual({ removed: 0, failed: 0 });
    const broken = { ...world.files, list: () => Promise.reject(new Error('I/O error')) };
    await expect(sweepOrphanFiles({ db: world.db, files: broken, clock })).rejects.toThrow('I/O error');
  });
});

describe('sweepOrphanFiles: an mtime that cannot be milliseconds is unknown (c)', () => {
  it('an mtime below 1e12 (seconds, or zero) keeps the file, however old it would look; a plausible one is swept', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(NOW);
    await world.files.write('media/in-seconds.jpg', jpegBytes());
    world.files.setMtime('media/in-seconds.jpg', Math.floor(NOW / 1000) - 7200);
    await world.files.write('media/zero.jpg', jpegBytes());
    world.files.setMtime('media/zero.jpg', 0);
    await world.files.write('media/negative.jpg', jpegBytes());
    world.files.setMtime('media/negative.jpg', -5);
    await world.files.write('media/plausible.jpg', jpegBytes());
    world.files.setMtime('media/plausible.jpg', NOW - 2 * ORPHAN_MIN_AGE_MS);
    expect(await sweepOrphanFiles({ db: world.db, files: world.files, clock })).toEqual({ removed: 1, failed: 0 });
    expect(world.files.paths().sort()).toEqual(['media/in-seconds.jpg', 'media/negative.jpg', 'media/zero.jpg']);
  });
});

describe('sweepOrphanFiles: the checks are repeated right before the removal (e)', () => {
  it('a row inserted after the first look (a put that was racing the sweep) protects the file', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(NOW);
    await world.files.write('media/racing.jpg', jpegBytes());
    world.files.setMtime('media/racing.jpg', NOW - 2 * ORPHAN_MIN_AGE_MS);
    const meta = JSON.stringify({ targetType: 'item', findingKey: 'k', itemId: 'i' });
    const realQuery = world.db.query.bind(world.db);
    let lookups = 0;
    const racing = {
      ...world.db,
      query: async (sql: string, params?: unknown[]) => {
        const answer = await realQuery(sql, params);
        lookups += 1;
        if (lookups === 1) {
          await world.db.run(
            'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
            ['racing', INSPECTION, 'photo', 'media/racing.jpg', 'image/jpeg', meta, 'pending', 0, 1],
          );
        }
        return answer;
      },
    } as typeof world.db;
    expect(await sweepOrphanFiles({ db: racing, files: world.files, clock })).toEqual({ removed: 0, failed: 0 });
    expect(world.files.paths()).toEqual(['media/racing.jpg']);
    expect(world.files.removeCalls()).toEqual([]);
  });

  it('a file rewritten after the first look (its mtime is fresh again) is kept', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(NOW);
    await world.files.write('media/rewritten.jpg', jpegBytes());
    world.files.setMtime('media/rewritten.jpg', NOW - 2 * ORPHAN_MIN_AGE_MS);
    const realQuery = world.db.query.bind(world.db);
    const racing = {
      ...world.db,
      query: async (sql: string, params?: unknown[]) => {
        const answer = await realQuery(sql, params);
        world.files.setMtime('media/rewritten.jpg', NOW);
        return answer;
      },
    } as typeof world.db;
    expect(await sweepOrphanFiles({ db: racing, files: world.files, clock })).toEqual({ removed: 0, failed: 0 });
    expect(world.files.removeCalls()).toEqual([]);
  });

  it('positive control: with no race the orphan is removed', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(NOW);
    await world.files.write('media/calm.jpg', jpegBytes());
    world.files.setMtime('media/calm.jpg', NOW - 2 * ORPHAN_MIN_AGE_MS);
    expect(await sweepOrphanFiles({ db: world.db, files: world.files, clock })).toEqual({ removed: 1, failed: 0 });
  });
});
