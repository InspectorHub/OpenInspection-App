import { describe, expect, it } from 'vitest';
import { createManualClock } from '../platform/clock';
import { ORPHAN_MIN_AGE_MS, sweepOrphanFiles } from './sweep';
import { createMediaWorld, INSPECTION, jpegBytes, photoRecord } from './test-support/fakes';

const NOW = 100 * 3_600_000;

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
    world.files.setMtime('media/odd.jpg', 0);
    await world.files.write('media/stuck.jpg', jpegBytes());
    world.files.setMtime('media/stuck.jpg', 0);
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
