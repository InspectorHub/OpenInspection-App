import { beforeEach, describe, expect, it } from 'vitest';
import { createPackageWorld, jsonReply, type PackageWorld } from './test-support/package-world';
import type { RefreshProgress } from './work-package';

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld();
});

describe('download progress', () => {
  it('reports done of total as each inspection finishes, starting at zero, and forgets the listener when the flight ends', async () => {
    w.serve('a');
    w.serve('b');
    w.serve('c');
    const events: RefreshProgress[] = [];
    const summary = await w.refresher.refresh({ reason: 'manual', onProgress: (p) => events.push(p) });
    expect(summary.refreshed).toBe(3);
    expect(events[0]).toEqual({ done: 0, total: 3 });
    expect(events[events.length - 1]).toEqual({ done: 3, total: 3 });
    expect(events.map((e) => e.done).sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
    expect(events.every((e) => e.total === 3)).toBe(true);
    const count = events.length;
    await w.run();
    expect(events.length).toBe(count);
  });

  it('a listener that throws does not change what the run does', async () => {
    w.serve('a');
    const summary = await w.refresher.refresh({
      reason: 'manual',
      onProgress: () => {
        throw new Error('listener blew up');
      },
    });
    expect(summary.refreshed).toBe(1);
  });

  it('a run with nothing to download reports zero of zero once', async () => {
    const events: RefreshProgress[] = [];
    await w.refresher.refresh({ reason: 'manual', onProgress: (p) => events.push(p) });
    expect(events).toEqual([{ done: 0, total: 0 }]);
  });
});

describe('failed inspections are named', () => {
  it('the summary lists the inspections whose download failed, in the order they failed', async () => {
    w.serve('t1');
    w.serve('t2');
    w.pkg.overrides.set('/api/inspections/t2/results', () => jsonReply(200, { success: false, data: { v: 2 } }));
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 1, failed: 1 });
    expect(summary.failedIds).toEqual(['t2']);
  });

  it('a run with no failures names none', async () => {
    w.serve('t1');
    const summary = await w.run();
    expect(summary.failed).toBe(0);
    expect(summary.failedIds).toEqual([]);
  });
});
