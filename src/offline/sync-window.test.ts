import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SYNC_DAYS, readSyncDays } from './work-package';
import { SYNC_WINDOW_CHOICES, syncWindowChoice, writeSyncDays } from './sync-window';
import { NOW, createPackageWorld, type PackageWorld } from './test-support/package-world';

let w: PackageWorld;
beforeEach(async () => {
  w = await createPackageWorld();
});

const day = (offset: number): string => `${new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10)}T10:00:00.000Z`;
const windowedQuery = () => w.pkg.requests.find((r) => r.path === '/api/inspections' && r.query.has('dateFrom'));
const packageIds = async (): Promise<string[]> => (await w.db.query<{ inspection_id: string }>('SELECT inspection_id FROM work_package ORDER BY inspection_id')).map((r) => r.inspection_id);

describe('the sync window setting', () => {
  it('offers 7, 14 and 30 days, 14 by default', async () => {
    expect([...SYNC_WINDOW_CHOICES]).toEqual([7, 14, 30]);
    expect(DEFAULT_SYNC_DAYS).toBe(14);
    expect(await readSyncDays(w.db)).toBe(14);
  });

  it.each([7, 14, 30] as const)('writing %i days is what the refresher reads back', async (days) => {
    await writeSyncDays(w.db, days);
    expect(await readSyncDays(w.db)).toBe(days);
  });

  it('writing again replaces the value (one row, not two)', async () => {
    await writeSyncDays(w.db, 7);
    await writeSyncDays(w.db, 30);
    expect((await w.db.query("SELECT value FROM device_state WHERE key = 'sync_days'")).length).toBe(1);
    expect(await readSyncDays(w.db)).toBe(30);
  });

  it.each([0, 1, 13, 31, 60, -7, 7.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s: only the three choices are written (control: 14 is accepted)', async (days) => {
    await expect(writeSyncDays(w.db, days)).rejects.toThrow(RangeError);
    expect(await w.db.query("SELECT value FROM device_state WHERE key = 'sync_days'")).toEqual([]);
    await writeSyncDays(w.db, 14);
    expect(await readSyncDays(w.db)).toBe(14);
  });

  it('the refresher really asks the server for the chosen window', async () => {
    w.serve('t1');
    await writeSyncDays(w.db, 7);
    await w.run();
    expect(windowedQuery()?.query.get('dateTo')).toBe('2026-11-03');
    w.pkg.requests.length = 0;
    await writeSyncDays(w.db, 30);
    await w.run();
    expect(windowedQuery()?.query.get('dateTo')).toBe('2026-11-26');
  });

  it('shrinking the window downloads less and deletes nothing that is already on the device', async () => {
    // Open inspections (requested, scheduled, confirmed) are always listed whatever the window; the window bounds the finished ones.
    w.serve('near', { date: day(2), status: 'completed' });
    w.serve('far', { date: day(25), status: 'completed' });
    await writeSyncDays(w.db, 30);
    await w.run();
    expect(await packageIds()).toEqual(['far', 'near']);
    const cachedBefore = await w.cachedKeys('far');
    expect(cachedBefore.length).toBeGreaterThan(0);

    await writeSyncDays(w.db, 7);
    w.pkg.requests.length = 0;
    const summary = await w.run();

    expect(summary.failed).toBe(0);
    expect(await packageIds()).toEqual(['far', 'near']);
    expect(await w.cachedKeys('far')).toEqual(cachedBefore);
    expect(await w.db.query('SELECT inspection_id FROM work_package WHERE purging <> 0 OR quarantine_source IS NOT NULL')).toEqual([]);
  });

  it('control: the wider window is what fetches the far inspection in the first place', async () => {
    w.serve('far', { date: day(25), status: 'completed' });
    await writeSyncDays(w.db, 7);
    await w.run();
    expect(await packageIds()).toEqual([]);
    await writeSyncDays(w.db, 30);
    await w.run();
    expect(await packageIds()).toEqual(['far']);
  });
});

describe('syncWindowChoice', () => {
  it('names the choice a stored value stands for, or null for a value the screen does not offer', () => {
    expect(syncWindowChoice(14)).toBe(14);
    expect(syncWindowChoice(30)).toBe(30);
    expect(syncWindowChoice(21)).toBeNull();
    expect(syncWindowChoice(60)).toBeNull();
  });
});
