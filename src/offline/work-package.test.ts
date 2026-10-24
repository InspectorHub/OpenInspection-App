import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceInspectionResources } from './resource-cache';
import { ALICE, BOB } from './test-support/replay-world';
import { ALICE_KEY, NOW, TODAY, createPackageWorld, jsonReply, type PackageWorld } from './test-support/package-world';
import { DEFAULT_SYNC_DAYS, clampSyncDays, readPackageStates, readSyncDays } from './work-package';

const BASE = (id: string) => [`/api/inspections/${id}`, `/api/inspections/${id}/report-data`, `/api/inspections/${id}/results`];
const GLOBALS = ['/api/admin/defect-categories', '/api/contractor-types', '/api/recommendations', '/api/session/context', '/api/tags'];
const day = (offset: number, time = '10:00:00.000Z'): string => `${new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10)}T${time}`;

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld();
});

const rowOf = async (id: string) => (await w.db.query<Record<string, unknown>>('SELECT * FROM work_package WHERE inspection_id = ?', [id]))[0];
const firstRequestIndex = (id: string): number => w.pkg.requests.findIndex((r) => r.path === `/api/inspections/${id}`);

describe('a refresh', () => {
  it('downloads the base set of every listed inspection and the global reads, and records the package', async () => {
    w.serve('t1');
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 1, failed: 0, halted: null, leaseBusy: false });
    expect(await w.cachedKeys('t1')).toEqual(BASE('t1'));
    expect(await w.cachedKeys('$global')).toEqual(GLOBALS);
    expect(JSON.parse((await w.cached('/api/inspections/t1/results')) ?? 'null')).toEqual({ success: true, data: { path: '/api/inspections/t1/results', v: 1 } });
    expect(await rowOf('t1')).toMatchObject({ tenant_id: ALICE.tenantId, user_id: ALICE.userId, server_confirmed: 1, completed: 0, scheduled_at: Date.parse(day(0, '15:00:00.000Z')), refreshed_at: NOW, package_gen: 1, purging: 0 });
  });

  it('reads the optional resources the inspection row asks for', async () => {
    w.serve('c1', { row: { propertyType: 'commercial', reportTier: 'full_pca' } });
    w.serve('s1', { row: { propertyType: 'single_family', templateSnapshot: { statutoryForm: { id: 'trec' } } } });
    await w.run();
    expect(await w.cachedKeys('c1')).toEqual([...BASE('c1'), '/api/inspections/c1/compliance', '/api/inspections/c1/cost-items', '/api/inspections/c1/unit-progress', '/api/inspections/c1/units'].sort());
    expect(await w.cachedKeys('s1')).toEqual([...BASE('s1'), '/api/inspections/s1/statutory-details', '/api/inspections/s1/statutory-form/coverage'].sort());
  });

  it('only ever sends authenticated GETs to the pinned origin, with no body and the client headers', async () => {
    w.serve('t1');
    await w.run();
    expect(w.pkg.requests.length).toBeGreaterThan(8);
    for (const request of w.pkg.requests) {
      expect(request.method).toBe('GET');
      expect(request.url.startsWith('https://oi.example.test/api/')).toBe(true);
      expect(request.body).toBeUndefined();
      expect(request.headers.Authorization).toBe('Bearer access-token-secret');
      expect(request.headers['X-Client-Platform']).toBe('android');
      expect(request.path).toMatch(/^\/api\/(inspections|session\/context$|tags$|recommendations$|contractor-types$|admin\/defect-categories$)/);
    }
  });

  it('never lets a client header replace the credential', async () => {
    const hostile = await createPackageWorld({ clientHeaders: { authorization: 'Bearer evil', Cookie: 'x=1', 'X-Client-Version': '9' } });
    hostile.serve('t1');
    await hostile.run();
    for (const request of hostile.pkg.requests) {
      expect(request.headers.Authorization).toBe('Bearer access-token-secret');
      expect(Object.keys(request.headers).map((k) => k.toLowerCase())).not.toContain('cookie');
      expect(request.headers.authorization).toBeUndefined();
    }
  });

  it('refuses a stored origin that is not an origin', () => {
    expect(() => w.build({ origin: 'https://oi.example.test/path' })).toThrow();
    expect(() => w.build({ origin: 'http://oi.example.test' })).toThrow();
  });
});

describe('which inspections are in the package', () => {
  it('asks the server for mine in the window, and for every unfinished one of mine, and merges them', async () => {
    w.serve('soon', { date: day(3) });
    w.serve('later', { status: 'confirmed', date: day(90) });
    w.serve('far-done', { status: 'completed', date: day(90) });
    w.serve('theirs', { inspectorId: 'someone-else' });
    await w.run();
    const lists = w.pkg.requests.filter((r) => r.path === '/api/inspections');
    for (const list of lists) {
      expect(list.query.get('inspectorId')).toBe('alice');
      expect(list.query.get('limit')).toBe('100');
    }
    const windowed = lists.filter((r) => r.query.has('dateFrom'));
    expect(windowed).toHaveLength(1);
    expect(windowed[0]?.query.get('dateFrom')).toBe('2026-10-25');
    expect(windowed[0]?.query.get('dateTo')).toBe('2026-11-10');
    expect(lists.filter((r) => r.query.has('status')).map((r) => r.query.get('status')).sort()).toEqual(['confirmed', 'requested', 'scheduled']);
    expect((await w.db.query<{ inspection_id: string }>('SELECT inspection_id FROM work_package ORDER BY inspection_id')).map((r) => r.inspection_id)).toEqual(['later', 'soon']);
    expect(w.pkg.forInspection('far-done')).toEqual([]);
    expect(w.pkg.forInspection('theirs')).toEqual([]);
  });

  it('an inspection found by two of the queries is fetched once', async () => {
    w.serve('both', { date: day(2) });
    await w.run();
    expect(w.pkg.requests.filter((r) => r.path === '/api/inspections/both')).toHaveLength(1);
  });

  it('follows the cursor across pages', async () => {
    for (let i = 0; i < 105; i += 1) w.serve(`bulk-${String(i).padStart(3, '0')}`, { date: day(1) });
    const summary = await w.run();
    expect(summary.refreshed).toBe(105);
    const windowed = w.pkg.requests.filter((r) => r.path === '/api/inspections' && r.query.has('dateFrom'));
    expect(windowed.map((r) => r.query.get('cursor'))).toEqual([null, '100']);
  });

  it('skips a cancelled inspection in the window, and counts and skips ids that are not safe path segments', async () => {
    w.serve('cancelled-one', { status: 'cancelled' });
    w.serve('good');
    for (const bad of ['bulk', 'a/b', '..', 'has space', 'x'.repeat(65), 'q?x=1']) w.serve(bad);
    const summary = await w.run();
    expect(summary.refreshed).toBe(1);
    expect(summary.invalidIds).toBe(6);
    expect(w.pkg.requests.filter((r) => r.path !== '/api/inspections').map((r) => r.path).some((p) => p.includes('cancelled-one') || p.includes('bulk') || p.includes('..') || p.includes('%'))).toBe(false);
    expect(await w.db.query('SELECT inspection_id FROM work_package')).toEqual([{ inspection_id: 'good' }]);
  });

  it('includes a pinned package that the list no longer shows, from the local pin and not from the server', async () => {
    await w.seed('pinned-gone', { pinned: 1 });
    w.serve('pinned-gone', { inspectorId: 'someone-else', date: day(200) });
    await w.run();
    expect(await w.cachedKeys('pinned-gone')).toEqual(BASE('pinned-gone'));
  });

  it('a package that drops out of the list is not deleted, not fetched, and its cache is kept', async () => {
    await w.seed('dropped', { refreshedAt: 5 });
    await replaceInspectionResources(w.db, { accountKey: ALICE_KEY, inspectionId: 'dropped', packageGen: 0, resources: new Map([['/api/inspections/dropped', { body: '{"success":true,"data":{}}', fetchedAt: 5 }]]), refreshedAt: 5 });
    w.serve('other');
    await w.run();
    expect(await rowOf('dropped')).toMatchObject({ refreshed_at: 5, package_gen: 1, purging: 0, quarantine_source: null });
    expect(await w.cached('/api/inspections/dropped')).toBe('{"success":true,"data":{}}');
    expect(w.pkg.forInspection('dropped')).toEqual([]);
  });

  it('leaves a local create alone even when the server already lists it, and a package of another account', async () => {
    await w.seed('local', { confirmed: 0 });
    await w.seed('theirs', { account: BOB });
    w.serve('local');
    w.serve('theirs');
    w.serve('mine');
    const summary = await w.run();
    expect(summary.refreshed).toBe(1);
    expect(w.pkg.forInspection('local')).toEqual([]);
    expect(w.pkg.forInspection('theirs')).toEqual([]);
    expect(await rowOf('local')).toMatchObject({ server_confirmed: 0, refreshed_at: 0, scheduled_at: null, package_gen: 0 });
    expect(await rowOf('theirs')).toMatchObject({ tenant_id: BOB.tenantId, user_id: BOB.userId, refreshed_at: 0, scheduled_at: null });
    expect(await w.cachedKeys('local')).toEqual([]);
  });

  it('does not fetch a quarantined or purging package, while the same pinned package without either is fetched', async () => {
    await w.seed('quarantined', { pinned: 1, quarantine: 'reconcile_missing' });
    await w.seed('purging', { pinned: 1, purging: 1 });
    await w.seed('healthy', { pinned: 1 });
    w.serve('quarantined');
    w.serve('purging');
    w.serve('healthy');
    await w.run();
    expect(w.pkg.forInspection('quarantined')).toEqual([]);
    expect(w.pkg.forInspection('purging')).toEqual([]);
    expect(w.pkg.forInspection('healthy')).not.toEqual([]);
  });
});

describe('sync_days', () => {
  it.each([
    [undefined, 14],
    ['30', 30],
    ['1', 1],
    ['60', 60],
    ['0', 1],
    ['-5', 14],
    ['61', 60],
    ['9999', 60],
    ['abc', 14],
    ['', 14],
    ['7.5', 14],
    ['1e3', 14],
  ])('reads %j as %i days', async (stored, expected) => {
    if (stored !== undefined) await w.db.run("INSERT INTO device_state (key, value) VALUES ('sync_days', ?)", [stored]);
    expect(await readSyncDays(w.db)).toBe(expected);
  });

  it('clamps numbers into 1..60 and defaults the rest', () => {
    expect([clampSyncDays(0), clampSyncDays(1), clampSyncDays(60), clampSyncDays(61), clampSyncDays(Number.NaN), clampSyncDays(Number.POSITIVE_INFINITY)]).toEqual([1, 1, 60, 60, DEFAULT_SYNC_DAYS, DEFAULT_SYNC_DAYS]);
  });

  it('puts the window in the request: a wider setting asks for a later end date', async () => {
    await w.db.run("INSERT INTO device_state (key, value) VALUES ('sync_days', '999')");
    w.serve('t1');
    await w.run();
    const windowed = w.pkg.requests.find((r) => r.path === '/api/inspections' && r.query.has('dateFrom'));
    expect(windowed?.query.get('dateTo')).toBe('2026-12-26');
  });
});

describe('priority and budget', () => {
  async function arrange(): Promise<void> {
    await w.seed('pinned', { pinned: 1 });
    w.serve('pinned', { date: day(5) });
    w.serve('rest-b', { date: day(8) });
    w.serve('rest-a', { date: day(3) });
    w.serve('today-pm', { date: `${TODAY}T15:00:00.000Z` });
    w.serve('today-am', { date: `${TODAY}T09:00:00.000Z` });
  }

  it('with one request at a time: today first, then pinned, then the rest of the window by date', async () => {
    const one = await createPackageWorld({ concurrency: 1 });
    w = one;
    await arrange();
    await w.run();
    const order = ['today-am', 'today-pm', 'pinned', 'rest-a', 'rest-b'];
    const starts = order.map(firstRequestIndex);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts.every((s) => s > 0)).toBe(true);
    // Everything of one inspection is requested before the next inspection starts.
    expect(w.pkg.requests.slice(starts[0], starts[1]).every((r) => r.path.startsWith('/api/inspections/today-am'))).toBe(true);
  });

  it('a pinned package that is also today is in the first tier', async () => {
    w = await createPackageWorld({ concurrency: 1 });
    await w.seed('pinned-today', { pinned: 1 });
    w.serve('pinned-today', { date: `${TODAY}T20:00:00.000Z` });
    w.serve('today-am', { date: `${TODAY}T09:00:00.000Z` });
    w.serve('pinned', { date: day(5) });
    await w.seed('pinned', { pinned: 1 });
    await w.run();
    expect(firstRequestIndex('today-am')).toBeLessThan(firstRequestIndex('pinned-today'));
    expect(firstRequestIndex('pinned-today')).toBeLessThan(firstRequestIndex('pinned'));
  });

  it.each([1, 2, 3])('never has more than %i requests in flight, and does reach that many, also while one inspection reads several resources at once', async (concurrency) => {
    w = await createPackageWorld({ concurrency });
    for (let i = 0; i < 8; i += 1) w.serve(`n${String(i)}`, { date: day(1) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = () => w.pkg.requests.filter((r) => r.path.endsWith('/results') || r.path.endsWith('/report-data'));
    w.pkg.hook = async (request) => {
      if (request.path.endsWith('/results') || request.path.endsWith('/report-data')) await gate;
    };
    const flight = w.run();
    await vi.waitFor(() => expect(held()).toHaveLength(concurrency));
    for (let i = 0; i < 300; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(held()).toHaveLength(concurrency);
    expect(w.pkg.maxInFlight()).toBe(concurrency);
    release();
    await flight;
    expect(w.pkg.maxInFlight()).toBe(concurrency);
  });

  it('a larger concurrency than the hard limit is held to it', async () => {
    w = await createPackageWorld({ concurrency: 50 });
    for (let i = 0; i < 12; i += 1) w.serve(`n${String(i)}`, { date: day(1) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.pkg.hook = async (request) => {
      if (request.path.endsWith('/results') || request.path.endsWith('/report-data')) await gate;
    };
    const flight = w.run();
    await vi.waitFor(() => expect(w.pkg.requests.filter((r) => r.path.endsWith('/results') || r.path.endsWith('/report-data'))).toHaveLength(3));
    for (let i = 0; i < 300; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(w.pkg.maxInFlight()).toBe(3);
    release();
    await flight;
    expect(w.pkg.maxInFlight()).toBe(3);
  });

  it('the high-priority inspections all start before any lower tier does, with concurrency 3', async () => {
    await arrange();
    await w.run();
    const top = ['today-am', 'today-pm', 'pinned'].map(firstRequestIndex);
    const lower = ['rest-a', 'rest-b'].map(firstRequestIndex);
    expect(Math.max(...top)).toBeLessThan(Math.min(...lower));
  });
});

describe('freshness', () => {
  it('does not download an inspection again within the freshness window, unless asked by a person', async () => {
    w.serve('t1');
    await w.run('start');
    w.pkg.requests.length = 0;
    await w.run('start');
    expect(w.pkg.forInspection('t1')).toEqual([]);
    await w.run('manual');
    expect(w.pkg.forInspection('t1').sort()).toEqual(BASE('t1'));
  });

  it('downloads again once the window has passed, and when the clock was set back before the last refresh', async () => {
    w.serve('t1');
    await w.run('start');
    w.pkg.requests.length = 0;
    w.clock.advance(299_999);
    await w.run('start');
    expect(w.pkg.forInspection('t1')).toEqual([]);
    w.clock.advance(2);
    await w.run('start');
    expect(w.pkg.forInspection('t1').sort()).toEqual(BASE('t1'));
    w.pkg.requests.length = 0;
    w.clock.set(NOW - 3_600_000);
    await w.run('start');
    expect(w.pkg.forInspection('t1').sort()).toEqual(BASE('t1'));
  });

  it('the global reads follow the same window: skipped while fresh, read again after it or when asked', async () => {
    w.serve('t1');
    await w.run('start');
    w.pkg.requests.length = 0;
    await w.run('start');
    expect(w.pkg.requests.filter((r) => r.path === '/api/tags')).toHaveLength(0);
    w.clock.advance(300_001);
    await w.run('start');
    expect(w.pkg.requests.filter((r) => r.path === '/api/tags')).toHaveLength(1);
    w.pkg.requests.length = 0;
    w.clock.advance(1000);
    await w.run('start');
    expect(w.pkg.requests.filter((r) => r.path === '/api/tags')).toHaveLength(0);
    await w.run('manual');
    expect(w.pkg.requests.filter((r) => r.path === '/api/tags')).toHaveLength(1);
    w.pkg.requests.length = 0;
    w.clock.set(NOW - 3_600_000);
    await w.run('start');
    expect(w.pkg.requests.filter((r) => r.path === '/api/tags')).toHaveLength(1);
  });

  it('a recorded failure makes the inspection due again at once', async () => {
    w.serve('t1');
    await w.run('start');
    await w.db.run("INSERT OR REPLACE INTO resource_cache (account_key, key, body, fetched_at, package_id) VALUES (?, '$refresh_error', 'server_error', 1, 't1')", [ALICE_KEY]);
    w.pkg.requests.length = 0;
    await w.run('start');
    expect(w.pkg.forInspection('t1').sort()).toEqual(BASE('t1'));
  });
});

describe('package states for the work list', () => {
  it('reports last refresh, last error and what is cached, for this account only', async () => {
    w = await createPackageWorld({ limits: { maxAttempts: 1 } });
    w.serve('ok');
    w.serve('bad');
    w.pkg.overrides.set('/api/inspections/bad/results', () => jsonReply(500, { success: false }));
    await w.run();
    await w.seed('theirs', { account: BOB });
    const states = await readPackageStates(w.db, ALICE);
    expect(states.map((s) => s.inspectionId).sort()).toEqual(['bad', 'ok']);
    expect(states.find((s) => s.inspectionId === 'ok')).toMatchObject({ lastRefreshedAt: NOW, lastError: null, cachedResources: 3, pinned: false });
    expect(states.find((s) => s.inspectionId === 'bad')).toMatchObject({ lastRefreshedAt: null, lastError: 'server_error', cachedResources: 0 });
  });
});
