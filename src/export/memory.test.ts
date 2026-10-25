import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { FLUSH_BYTES } from './build-package';
import { createExporter } from './exporter';
import { createExportWorld, seedInspection, sharedPackage } from './test-support/world';

const PHOTO_BYTES = 64 * 1024;
const PHOTOS = 500;

describe('a large export does not hold the photos in memory', () => {
  it('reads 500 photos one at a time and has written what it read before it reads the next', async () => {
    const world = await createExportWorld();
    world.files.retain(false);
    const photos = Array.from({ length: PHOTOS }, (_, i) => ({ pendingId: `p${String(i)}` }));
    await seedInspection(world, 'insp-1', { photos });
    for (const photo of photos) world.files.generate(`media/${photo.pendingId}.jpg`, PHOTO_BYTES);

    const outcome = await createExporter({ db: world.db, files: world.files, clock: world.clock, sharer: world.sharer }).run({ includeQuarantined: false, confirmed: true });
    expect(outcome).toMatchObject({ kind: 'shared', photos: PHOTOS });

    const reads = world.files.reads().filter((read) => read.path.startsWith('media/p'));
    expect(reads).toHaveLength(PHOTOS);
    expect(new Set(reads.map((read) => read.path)).size).toBe(PHOTOS);
    expect(world.files.maxConcurrentReads()).toBe(1);
    // Photos alive at once = bytes read but not yet written to the cache, in photo units. One photo is being handled, and
    // the coalescing buffer may hold up to FLUSH_BYTES of already-read photos; nothing else accumulates.
    const allowed = Math.ceil(FLUSH_BYTES / PHOTO_BYTES) + 2;
    const worst = Math.max(...reads.map((read) => Math.ceil((read.readBefore - read.writtenAtRead) / PHOTO_BYTES)));
    expect(worst).toBeLessThanOrEqual(allowed);
    expect(world.files.readBytes()).toBe(PHOTOS * PHOTO_BYTES);
    expect(world.files.writtenBytes()).toBeGreaterThan(PHOTOS * PHOTO_BYTES);
  });

  it('control: a builder that read everything first would fail the same measure', () => {
    const readBefore = (PHOTOS - 1) * PHOTO_BYTES;
    const worst = Math.ceil(readBefore / PHOTO_BYTES);
    expect(worst).toBeGreaterThan(Math.ceil(FLUSH_BYTES / PHOTO_BYTES) + 2);
  });

  it('still produces a package the reader takes whole: every photo, in the index and as a file', async () => {
    const world = await createExportWorld();
    const photos = Array.from({ length: 40 }, (_, i) => ({ pendingId: `p${String(i)}` }));
    await seedInspection(world, 'insp-1', { photos });
    await createExporter({ db: world.db, files: world.files, clock: world.clock, sharer: world.sharer }).run({ includeQuarantined: false, confirmed: true });
    const pkg = sharedPackage(world);
    expect(pkg.media).toHaveLength(40);
    expect(Object.keys(unzipSync(world.sharer.calls[0]?.bytes ?? new Uint8Array())).filter((name) => name.endsWith('.jpg'))).toHaveLength(40);
  });
});
