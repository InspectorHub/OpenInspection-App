import { afterEach, describe, expect, it } from 'vitest';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { leftOutNotes, summaryText } from './copy';
import { createExporter, type ExportDone, type ExporterDeps } from './exporter';
import { EXPORT_RETAIN_MS, exportFileName } from './format';
import { RECONCILE_WAIT_MS, reconcileGateFor } from './reconcile-gate';
import { isShareCancel } from './share-package';
import { SWEEP_AGE_MS, sweepStaleExports } from './sweep';
import { NOW, createExportWorld, createManualTimers, outcomeFixture, seedInspection, type ExportWorld, type ManualTimers } from './test-support/world';

afterEach(restoreGlobals);

const MINUTE = 60_000;

async function setup(extra: Partial<ExporterDeps> = {}): Promise<{ world: ExportWorld; timers: ManualTimers; run: () => ReturnType<ReturnType<typeof createExporter>['run']> }> {
  const world = await createExportWorld();
  await seedInspection(world, 'insp-a', { writes: ['update'], photos: [{ pendingId: 'p1' }] });
  const timers = createManualTimers();
  const exporter = createExporter({ db: world.db, files: world.files, clock: world.clock, sharer: world.sharer, platform: 'android', timers, ...extra });
  return { world, timers, run: () => exporter.run({ includeQuarantined: false, confirmed: true }) };
}

describe('on Android the file outlives the share sheet by a bound, whatever the sheet answered', () => {
  it('is still there when the sheet returns, and is deleted by the timer after ten minutes', async () => {
    const { world, timers, run } = await setup();
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: 'shared', kept: true, leftover: false });
    expect(world.files.cacheNames()).toEqual([exportFileName(NOW)]);
    expect(timers.pending()).toEqual([EXPORT_RETAIN_MS]);
    expect(EXPORT_RETAIN_MS).toBe(10 * MINUTE);
    timers.fire();
    await Promise.resolve();
    expect(world.files.cacheNames()).toEqual([]);
  });

  it.each(['cancel', 'error'] as const)('keeps it after a share that answered %s, with the same bound', async (mode) => {
    const { world, timers, run } = await setup();
    world.sharer.mode = mode;
    const outcome = await run();
    expect(outcome).toMatchObject(mode === 'cancel' ? { kind: 'cancelled', kept: true } : { kind: 'failed', code: 'share_failed' });
    expect(world.files.cacheNames()).toEqual([exportFileName(NOW)]);
    expect(timers.pending()).toEqual([EXPORT_RETAIN_MS]);
    expect(world.files.removeCalls().filter((name) => name === exportFileName(NOW))).toEqual([]);
  });

  it('does not delete the file at once for a cancel, which on Android may be a target that picked up the file', async () => {
    const { world, run } = await setup();
    world.sharer.mode = 'cancel';
    let during = false;
    world.sharer.during = () => {
      during = world.files.cacheNames().length === 1;
    };
    await run();
    expect(during).toBe(true);
    expect(world.files.cacheNames()).toHaveLength(1);
  });

  it('control: on iOS the file is deleted as soon as the sheet returns, answered or cancelled or failed', async () => {
    for (const mode of ['ok', 'cancel', 'error'] as const) {
      const { world, timers, run } = await setup({ platform: 'ios' });
      world.sharer.mode = mode;
      await run();
      expect(world.files.cacheNames()).toEqual([]);
      expect(timers.asked()).toEqual([]);
    }
  });

  it('a build that fails removes its partial file at once, on Android too', async () => {
    const { world, timers, run } = await setup();
    world.files.failWriteAfter(20);
    expect(await run()).toEqual({ kind: 'failed', code: 'build_failed' });
    expect(world.files.cacheNames()).toEqual([]);
    expect(timers.asked()).toEqual([]);
  });

  it('with no timer to be had the file stays for the sweeps, and the export still succeeds', async () => {
    const { world, run } = await setup({
      timers: {
        setTimeout: () => {
          throw new Error('no timers');
        },
        clearTimeout: () => undefined,
      },
    });
    expect(await run()).toMatchObject({ kind: 'shared', kept: true });
    expect(world.files.cacheNames()).toHaveLength(1);
  });

  it('a timer whose deletion fails does not throw out of the timer', async () => {
    const { world, timers, run } = await setup();
    await run();
    world.files.failRemoveCache();
    expect(() => timers.fire()).not.toThrow();
    await Promise.resolve();
  });
});

describe('the sweeps respect the same ten minutes', () => {
  it('a sweep at start, on the foreground and on sign-out keeps a file under ten minutes and removes one at ten', async () => {
    const { world, run } = await setup();
    await run();
    const name = exportFileName(NOW);
    expect(SWEEP_AGE_MS).toBe(EXPORT_RETAIN_MS);
    expect(await sweepStaleExports(world.files, NOW + 9 * MINUTE + 59_999, SWEEP_AGE_MS)).toEqual({ removed: 0, failed: 0 });
    expect(world.files.cacheNames()).toEqual([name]);
    expect(await sweepStaleExports(world.files, NOW + 10 * MINUTE, SWEEP_AGE_MS)).toEqual({ removed: 1, failed: 0 });
    expect(world.files.cacheNames()).toEqual([]);
  });

  it('the next export removes an earlier archive at once, however young', async () => {
    const { world, run, timers } = await setup();
    await run();
    const first = exportFileName(NOW);
    world.clock.advance(MINUTE);
    let during: string[] = [];
    world.sharer.during = () => {
      during = world.files.cacheNames();
    };
    await run();
    expect(during).toEqual([exportFileName(NOW + MINUTE)]);
    expect(world.files.cacheNames()).toEqual([exportFileName(NOW + MINUTE)]);
    expect(world.files.cacheNames()).not.toContain(first);
    expect(timers.asked()).toEqual([EXPORT_RETAIN_MS, EXPORT_RETAIN_MS]);
  });

  it('file names with too few digits, or too many, are not ours to sweep', async () => {
    const { world } = await setup();
    for (const name of ['inspectorhub-export-123456789.zip', 'inspectorhub-export-12345678901234567.zip']) world.files.seedCache(name);
    world.files.seedCache('inspectorhub-export-1000000000.zip');
    expect(await sweepStaleExports(world.files, NOW, 0)).toEqual({ removed: 1, failed: 0 });
    expect(world.files.cacheNames().sort()).toEqual(['inspectorhub-export-123456789.zip', 'inspectorhub-export-12345678901234567.zip']);
  });
});

describe('what the person is told about the file', () => {
  const done = (patch: Partial<ExportDone>): ExportDone => ({
    kind: 'shared',
    inspections: 1,
    photos: 0,
    writes: 0,
    unconfirmed: false,
    photosMissing: 0,
    omitted: { videos: 0, photoEdits: 0, skippedWrites: 0, failedWrites: 0, creationRefused: 0, alreadyOnServer: 0, reportIdUnknown: 0 },
    leftover: false,
    kept: false,
    changedSincePrepare: 0,
    ...patch,
  });

  it('on Android it says the file goes within ten minutes, for a share and for a cancel, and never that it was deleted', () => {
    for (const kind of ['shared', 'cancelled'] as const) {
      const text = summaryText(done({ kind, kept: true }));
      expect(text).toContain('The temporary file will be deleted within 10 minutes.');
      expect(text).not.toMatch(/was deleted|file was deleted/);
    }
  });

  it('on iOS it says the file was deleted', () => {
    expect(summaryText(done({ kept: false }))).toContain('The temporary file was deleted from this device.');
  });

  it('says what the server refused, what could not be created, what is already there and what has no report id', () => {
    const notes = leftOutNotes(done({ omitted: { videos: 0, photoEdits: 0, skippedWrites: 0, failedWrites: 2, creationRefused: 1, alreadyOnServer: 3, reportIdUnknown: 2 } }));
    expect(notes).toContain('2 changes the server refused stay on this device.');
    expect(notes).toContain('1 inspection could not be exported because their creation was refused; they stay on this device.');
    expect(notes).toContain('3 inspections were already fully on the server and were left out.');
    expect(notes).toContain('2 inspections may be refused by the receiving office because this server did not provide their report ids. They are still included.');
  });
});

describe('the share plugin strings the cancel test depends on', () => {
  // Pinned against @capacitor/share 8.0.3, SharePlugin.java and SharePlugin.swift: a dismissed sheet rejects "Share canceled" on
  // both platforms, and iOS rejects "Error sharing item" when the activity itself failed. A plugin update that changes either
  // wording must change this test, and the cancel handling, together.
  it('recognises the cancel wording and not the failure wording', () => {
    expect(isShareCancel(new Error('Share canceled'))).toBe(true);
    expect(isShareCancel(new Error('Error sharing item'))).toBe(false);
    expect(isShareCancel(new Error("Can't share while sharing is in progress"))).toBe(false);
    expect(isShareCancel('Share canceled')).toBe(false);
    expect(isShareCancel(null)).toBe(false);
  });
});

describe('the export path under the browser rules for builtins', () => {
  it('runs the reconcile wait and a whole Android export with the real timers and a strict setTimeout, clearTimeout and crypto', async () => {
    installStrictGlobals();
    const world = await createExportWorld();
    await seedInspection(world, 'insp-a', { writes: ['update'] });
    const gate = reconcileGateFor({ trigger: () => undefined, idle: () => Promise.resolve(), last: outcomeFixture({ status: 'never', at: null }) });
    expect(await gate()).toBe(false);
    const exporter = createExporter({ db: world.db, files: world.files, clock: world.clock, sharer: world.sharer, platform: 'android', reconcile: gate });
    expect((await exporter.prepare()).ids).toEqual(['insp-a']);
    // The delayed deletion is scheduled with the page's own setTimeout; a call with the wrong `this` would throw Illegal invocation here.
    expect(await exporter.run({ includeQuarantined: false, confirmed: false })).toMatchObject({ kind: 'shared', kept: true });
  });
});

describe('the wait for the server', () => {
  it('is fifteen seconds when nothing else is said, and the timer is cleared once the answer is in', async () => {
    const timers = createManualTimers();
    let current = outcomeFixture({ status: 'never', at: null });
    const gate = reconcileGateFor(
      {
        trigger: () => {
          current = outcomeFixture();
        },
        idle: () => Promise.resolve(),
        get last() {
          return current;
        },
      },
      { timers },
    );
    expect(await gate()).toBe(true);
    expect(timers.asked()).toEqual([15_000]);
    expect(RECONCILE_WAIT_MS).toBe(15_000);
    expect(timers.cleared()).toHaveLength(1);
    expect(timers.pending()).toEqual([]);
  });
});
