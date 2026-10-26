import { describe, expect, it } from 'vitest';
import { createExporter, type Exporter } from './exporter';
import { exportFileName } from './format';
import { createExportWorld, seedInspection, type ExportWorld } from './test-support/world';

const MINUTE = 60_000;

function exporterFor(world: ExportWorld): Exporter {
  return createExporter({ db: world.db, files: world.files, clock: world.clock, sharer: world.sharer, platform: 'ios' });
}

async function oneInspection(world: ExportWorld): Promise<void> {
  await seedInspection(world, 'insp-a', { writes: ['update'], photos: [{ pendingId: 'photo-a' }] });
}

describe('when an earlier export archive is deleted', () => {
  it('opening the question (prepare) leaves a recent archive alone, however often it is opened', async () => {
    const world = await createExportWorld();
    await oneInspection(world);
    const earlier = exportFileName(world.clock.now() - 2 * MINUTE);
    world.files.seedCache(earlier);
    const exporter = exporterFor(world);
    await exporter.prepare();
    world.clock.advance(MINUTE);
    await exporter.prepare();
    expect(world.files.cacheNames()).toEqual([earlier]);
    expect(world.files.removeCalls()).toEqual([]);
  });

  it('control: the export the person confirms does delete it, at its start, before the new archive is written', async () => {
    const world = await createExportWorld();
    await oneInspection(world);
    const earlier = exportFileName(world.clock.now() - 2 * MINUTE);
    world.files.seedCache(earlier);
    let during: string[] = [];
    world.sharer.during = () => {
      during = world.files.cacheNames();
    };
    await exporterFor(world).run({ includeQuarantined: false, confirmed: true });
    expect(world.files.removeCalls()).toContain(earlier);
    expect(during).not.toContain(earlier);
  });
});
