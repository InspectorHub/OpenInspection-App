import { beforeEach, describe, expect, it } from 'vitest';
import { SYNC_LEASE } from './lease';
import { cacheBytes } from './resource-cache';
import { ALICE, GOOD_TOKEN } from './test-support/replay-world';
import { ALICE_KEY, createPackageWorld, envelope, jsonReply, type PackageWorld } from './test-support/package-world';
import { DEFAULT_REFRESH_LIMITS, readPackageStates } from './work-package';

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld();
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const windowLists = (): number => w.pkg.requests.filter((r) => r.path === '/api/inspections' && r.query.has('dateFrom')).length;
const markerRows = (): Promise<{ package_id: string; body: string }[]> =>
  w.db.query<{ package_id: string; body: string }>("SELECT package_id, body FROM resource_cache WHERE SUBSTR(key, 1, 15) = '$refresh_error:' ORDER BY package_id");

/** Holds the first request of the run until the returned gate opens; later requests pass. */
function holdFirstRequest(): { reached: Promise<void>; release: () => void } {
  const hold = gate();
  const reached = gate();
  let first = true;
  w.pkg.hook = async () => {
    if (!first) return;
    first = false;
    reached.open();
    await hold.promise;
  };
  return { reached: reached.promise, release: hold.open };
}

describe('one marker per failing inspection, end to end', () => {
  it('two inspections that both answer 403 leave two markers, both are reported, and both are due again at once', async () => {
    w.serve('t1');
    w.serve('t2');
    await w.run();
    w.pkg.requests.length = 0;
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(403, { success: false }));
    w.pkg.overrides.set('/api/inspections/t2/results', () => jsonReply(403, { success: false }));
    const failed = await w.run('manual');
    expect(failed).toMatchObject({ failed: 2, refreshed: 0 });
    expect(await markerRows()).toEqual([
      { package_id: 't1', body: 'refused' },
      { package_id: 't2', body: 'refused' },
    ]);
    expect((await readPackageStates(w.db, ALICE)).map((s) => s.lastError)).toEqual(['refused', 'refused']);
    w.pkg.overrides.clear();
    w.pkg.requests.length = 0;
    w.clock.advance(31_000);
    const again = await w.run('start');
    expect(again).toMatchObject({ refreshed: 2, skipped: 0 });
    expect(await markerRows()).toEqual([]);
  });
});

describe('a manual request during a run is not answered with that run', () => {
  async function seedFresh(): Promise<void> {
    w.serve('t1');
    await w.seed('t1', { refreshedAt: w.clock.now() - 1000 });
  }

  it('queues a manual run behind a background one and resolves with the follow-up run, which ignores the freshness skip', async () => {
    await seedFresh();
    const held = holdFirstRequest();
    const background = w.refresher.refresh({ reason: 'online' });
    await held.reached;
    const asked = w.refresher.refresh({ reason: 'manual' });
    held.release();
    const summary = await asked;
    expect(await background).toBe(summary);
    expect(summary).toMatchObject({ refreshed: 1, skipped: 0 });
    expect(windowLists()).toBe(2);
    expect(w.pkg.forInspection('t1')).toHaveLength(3);
  });

  it('a request that is not manual shares the run and queues nothing, and a manual one during a manual run does not repeat it', async () => {
    await seedFresh();
    const held = holdFirstRequest();
    const background = w.refresher.refresh({ reason: 'online' });
    await held.reached;
    const shared = w.refresher.refresh({ reason: 'foreground' });
    held.release();
    const summary = await shared;
    expect(summary).toBe(await background);
    expect(summary).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(windowLists()).toBe(1);
    expect(w.pkg.forInspection('t1')).toEqual([]);

    w.pkg.requests.length = 0;
    const second = holdFirstRequest();
    const manual = w.refresher.refresh({ reason: 'manual' });
    await second.reached;
    const again = w.refresher.refresh({ reason: 'manual' });
    second.release();
    expect(await again).toBe(await manual);
    expect(windowLists()).toBe(1);
  });

  it('a call right after the last run finished starts a new run of its own', async () => {
    await seedFresh();
    await w.refresher.refresh({ reason: 'online' });
    const next = await w.refresher.refresh({ reason: 'manual' });
    expect(next).toMatchObject({ refreshed: 1 });
    expect(windowLists()).toBe(2);
  });
});

describe('a call made from the end of a run', () => {
  it('starts a run of its own, because the flight is already over by the time the halt is announced', async () => {
    let again: Promise<unknown> | null = null;
    w = await createPackageWorld({
      onHalt: () => {
        w.state.token = GOOD_TOKEN;
        again ??= w.refresher.refresh({ reason: 'manual' });
      },
    });
    w.serve('t1');
    w.state.token = null;
    const first = await w.refresher.refresh({ reason: 'manual' });
    expect(first.halted).toBe('auth');
    await again;
    expect(windowLists()).toBe(1);
    expect(w.pkg.forInspection('t1')).toHaveLength(3);
  });
});

describe('the list page cap', () => {
  const alwaysMore = (): void => {
    w.pkg.overrides.set('/api/inspections', () => jsonReply(200, envelope([], { nextCursor: 'more' })));
  };

  it('the default cap is ten pages, and a list that never ends is cut there and counted once per query', async () => {
    expect(DEFAULT_REFRESH_LIMITS.maxListPages).toBe(10);
    alwaysMore();
    const summary = await w.run();
    expect(summary).toMatchObject({ halted: null, listTruncated: 4 });
    expect(w.pkg.requests.filter((r) => r.path === '/api/inspections')).toHaveLength(40);
  });

  it('a list whose last page under the cap has no cursor is complete, one that still has a cursor on the capped page is not', async () => {
    w = await createPackageWorld({ limits: { maxListPages: 3 } });
    let page = 0;
    w.pkg.overrides.set('/api/inspections', () => {
      page += 1;
      return jsonReply(200, envelope([], { nextCursor: page % 3 === 0 ? null : 'more' }));
    });
    expect(await w.run()).toMatchObject({ halted: null, listTruncated: 0 });
    page = 0;
    w.pkg.overrides.set('/api/inspections', () => {
      page += 1;
      return jsonReply(200, envelope([], { nextCursor: page % 3 === 0 && page > 3 ? null : 'more' }));
    });
    expect(await w.run()).toMatchObject({ halted: null, listTruncated: 1 });
  });
});

describe('over the cache cap with nothing to evict', () => {
  async function seedPinnedTwo(): Promise<number> {
    w.serve('a');
    w.serve('b');
    await w.run();
    await w.db.run('UPDATE work_package SET pinned = 1');
    w.pkg.requests.length = 0;
    return cacheBytes(w.db, ALICE_KEY);
  }
  const bodyOf = async (key: string): Promise<number | null> => {
    const body = await w.cached(key);
    return body === null ? null : (JSON.parse(body) as { data: { v: number } }).data.v;
  };

  it('does not halt: packages it already holds are replaced, a new one is skipped and counted, and the summary says the cache is full', async () => {
    const total = await seedPinnedTwo();
    w.serve('c');
    w.pkg.version = 2;
    const summary = await w.build({ limits: { cacheCapBytes: total - 1 } }).refresh({ reason: 'manual' });
    expect(summary).toMatchObject({ halted: null, cacheFull: true, refreshed: 2, skippedCacheFull: 1, failed: 0 });
    expect(w.pkg.forInspection('c')).toEqual([]);
    expect(await w.cachedKeys('c')).toEqual([]);
    expect(await bodyOf('/api/inspections/a')).toBe(2);
    expect(await bodyOf('/api/inspections/b')).toBe(2);
  });

  it('refuses a replacement that would grow the cache and keeps the old rows, while one that does not grow goes through', async () => {
    const total = await seedPinnedTwo();
    w.pkg.overrides.set('/api/inspections/a/results', () => jsonReply(200, envelope({ path: 'results', padding: 'x'.repeat(500) })));
    const summary = await w.build({ limits: { cacheCapBytes: total - 1 } }).refresh({ reason: 'manual' });
    expect(summary).toMatchObject({ halted: null, cacheFull: true, refreshed: 1, skippedCacheFull: 1 });
    expect(await w.cached('/api/inspections/a/results')).not.toContain('padding');
    expect(await w.cachedKeys('a')).toHaveLength(3);
    w.pkg.overrides.set('/api/inspections/a/results', () => jsonReply(200, envelope({ p: 1 })));
    const shrunk = await w.build({ limits: { cacheCapBytes: total - 1 } }).refresh({ reason: 'manual' });
    expect(shrunk).toMatchObject({ refreshed: 2, skippedCacheFull: 0 });
    expect(await w.cached('/api/inspections/a/results')).toContain('"p":1');
  });

  it('under the cap the same new inspection is downloaded and the summary does not claim a full cache', async () => {
    const total = await seedPinnedTwo();
    w.serve('c');
    const summary = await w.build({ limits: { cacheCapBytes: total * 10 } }).refresh({ reason: 'manual' });
    expect(summary).toMatchObject({ halted: null, cacheFull: false, refreshed: 3, skippedCacheFull: 0 });
    expect(await w.cachedKeys('c')).toHaveLength(3);
  });
});

describe('a stopped refresher fetches no token', () => {
  it('a request that waited for a permit while the refresher was stopped does not ask for a token', async () => {
    w = await createPackageWorld({ concurrency: 1 });
    w.serve('t1');
    let tokenCalls = 0;
    w.state.tokenFn = () => {
      tokenCalls += 1;
      return Promise.resolve(w.state.token);
    };
    const hold = gate();
    const reached = gate();
    w.pkg.hook = async (request) => {
      if (request.path !== '/api/inspections/t1/results') return;
      reached.open();
      await hold.promise;
    };
    const flight = w.refresher.refresh({ reason: 'manual' });
    await reached.promise;
    const before = tokenCalls;
    const requestsBefore = w.pkg.requests.length;
    w.refresher.stop();
    hold.open();
    const summary = await flight;
    expect(summary.halted).toBe('stopped');
    expect(tokenCalls).toBe(before);
    expect(w.pkg.requests).toHaveLength(requestsBefore);
  });

  it('a token that arrives after stop() is not used for a request', async () => {
    w.serve('t1');
    const token = gate();
    const asked = gate();
    let tokenCalls = 0;
    w.state.tokenFn = async () => {
      tokenCalls += 1;
      asked.open();
      await token.promise;
      return w.state.token;
    };
    const flight = w.refresher.refresh({ reason: 'manual' });
    await asked.promise;
    w.refresher.stop();
    token.open();
    expect((await flight).halted).toBe('stopped');
    expect(tokenCalls).toBe(1);
    expect(w.pkg.requests).toHaveLength(0);
  });
});

describe('the write-time checks', () => {
  it('a lease lost between the last request and the write prevents the replace, and the same run with the lease kept writes', async () => {
    w.serve('t1');
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/t1/report-data') await w.db.run('DELETE FROM lease WHERE name = ?', [SYNC_LEASE]);
    };
    const lost = await w.run();
    expect(lost).toMatchObject({ halted: 'lease_lost', refreshed: 0 });
    expect(await w.cachedKeys('t1')).toEqual([]);
    w.pkg.hook = null;
    expect(await w.run()).toMatchObject({ halted: null, refreshed: 1 });
  });

  it.each([
    ['a quarantine', "UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 't1'"],
    ['the server no longer confirming it', "UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = 't1'"],
  ])('%s that lands while the download is running means nothing is written, and the same run without it writes', async (_name, interfere) => {
    w.serve('t1');
    await w.seed('t1');
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/t1/report-data') await w.db.run(interfere);
    };
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 0, skipped: 1, failed: 0 });
    expect(await w.cachedKeys('t1')).toEqual([]);
    expect(await w.db.query('SELECT package_gen FROM work_package')).toEqual([{ package_gen: 0 }]);
    await w.db.run("UPDATE work_package SET quarantine_source = NULL, server_confirmed = 1 WHERE inspection_id = 't1'");
    w.pkg.hook = null;
    expect(await w.run()).toMatchObject({ refreshed: 1 });
  });

  it('a required read that fails cancels the sibling reads of that inspection that have not been sent, while all five are sent when it succeeds', async () => {
    w = await createPackageWorld({ concurrency: 1 });
    w.serve('m1', { row: { propertyType: 'multi_family' } });
    expect(await w.run()).toMatchObject({ refreshed: 1 });
    expect(w.pkg.forInspection('m1')).toHaveLength(5);
    w.pkg.requests.length = 0;
    w.pkg.overrides.set('/api/inspections/m1/results', () => jsonReply(403, { success: false }));
    const summary = await w.run();
    expect(summary).toMatchObject({ failed: 1, refreshed: 0 });
    expect(w.pkg.forInspection('m1')).toEqual(['/api/inspections/m1', '/api/inspections/m1/results']);
  });

  it('a 404 resets the run of consecutive errors: error, 404, then three errors stop the run on the third, not on the second', async () => {
    w = await createPackageWorld({ concurrency: 1, limits: { maxAttempts: 1, maxConsecutiveErrors: 3 } });
    for (const id of ['t1', 't2', 't3', 't4', 't5']) w.serve(id);
    w.pkg.overrides.set('/api/inspections/t2', () => jsonReply(404, { success: false }));
    for (const id of ['t1', 't3', 't4', 't5']) w.pkg.overrides.set(`/api/inspections/${id}`, () => jsonReply(500, { success: false }));
    const summary = await w.run();
    expect(summary.halted).toBe('too_many_errors');
    expect(w.pkg.forInspection('t5')).toEqual(['/api/inspections/t5']);
    // t2 answered 404 on the inspection itself: not visible, which is not a failure.
    expect(summary).toMatchObject({ failed: 3, notVisible: 1 });
  });
});
