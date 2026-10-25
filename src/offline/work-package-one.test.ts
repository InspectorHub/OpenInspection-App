import { beforeEach, describe, expect, it } from 'vitest';
import { ALICE_KEY, createPackageWorld, type PackageWorld } from './test-support/package-world';
import { BOB } from './test-support/replay-world';

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld();
});

const version = async (id: string): Promise<number | null> => {
  const body = await w.cached(`/api/inspections/${id}/results`);
  return body === null ? null : (JSON.parse(body) as { data: { v: number } }).data.v;
};

describe('refreshInspection: one inspection, through the same guards', () => {
  it('re-downloads that inspection only: no list, no globals, no other inspection', async () => {
    w.serve('i1');
    w.serve('i2');
    await w.seed('i1');
    await w.seed('i2');
    await w.run();
    expect(await version('i1')).toBe(1);
    w.pkg.version = 2;
    w.pkg.requests.length = 0;
    expect(await w.refresher.refreshInspection('i1')).toEqual({ kind: 'refreshed' });
    expect(await version('i1')).toBe(2);
    expect(await version('i2')).toBe(1);
    expect(w.pkg.requests.every((r) => r.path.startsWith('/api/inspections/i1'))).toBe(true);
    expect(w.pkg.requests.some((r) => r.path === '/api/inspections')).toBe(false);
    expect(w.pkg.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('skips a quarantined or purging package; control: the same package refreshes when it is not', async () => {
    w.serve('i1');
    await w.seed('i1');
    expect(await w.refresher.refreshInspection('i1')).toEqual({ kind: 'refreshed' });
    await w.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'i1'");
    w.pkg.requests.length = 0;
    expect(await w.refresher.refreshInspection('i1')).toEqual({ kind: 'skipped' });
    await w.db.run("UPDATE work_package SET quarantine_source = NULL, purging = 1 WHERE inspection_id = 'i1'");
    expect(await w.refresher.refreshInspection('i1')).toEqual({ kind: 'skipped' });
    expect(w.pkg.requests).toHaveLength(0);
  });

  it('skips another account package and an id that is not an inspection id, without a request', async () => {
    w.serve('theirs');
    await w.seed('theirs', { account: BOB });
    expect(await w.refresher.refreshInspection('theirs')).toEqual({ kind: 'skipped' });
    expect(await w.refresher.refreshInspection('../x')).toEqual({ kind: 'skipped' });
    expect(w.pkg.requests).toHaveLength(0);
    expect(await w.cached('/api/inspections/theirs/results', ALICE_KEY)).toBeNull();
  });

  it('is halted while locked or offline and sends nothing; control: it goes when neither holds', async () => {
    w.serve('i1');
    await w.seed('i1');
    w.state.locked = true;
    expect(await w.refresher.refreshInspection('i1')).toEqual({ kind: 'halted', reason: 'locked' });
    w.state.locked = false;
    w.network.setQuietly(false);
    expect(await w.refresher.refreshInspection('i1')).toEqual({ kind: 'halted', reason: 'offline' });
    expect(w.pkg.requests).toHaveLength(0);
    w.network.setQuietly(true);
    expect((await w.refresher.refreshInspection('i1')).kind).toBe('refreshed');
  });

  it('a signed-out device is halted', async () => {
    w.serve('i1');
    await w.seed('i1');
    w.state.account = null;
    expect(await w.refresher.refreshInspection('i1')).toEqual({ kind: 'halted', reason: 'no_account' });
  });

  it('a failed download leaves the cache as it was and says failed', async () => {
    w.serve('i1');
    await w.seed('i1');
    await w.refresher.refreshInspection('i1');
    w.pkg.version = 2;
    w.pkg.inspections.delete('i1');
    expect(await w.refresher.refreshInspection('i1')).toEqual({ kind: 'failed' });
    expect(await version('i1')).toBe(1);
  });
});
