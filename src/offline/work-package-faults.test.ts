import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth/errors';
import { createHttp } from '../auth/http';
import { replaceInspectionResources } from './resource-cache';
import { ALICE, BOB } from './test-support/replay-world';
import { failingDb } from './test-support/failing-db';
import { ALICE_KEY, NOW, createPackageWorld, jsonReply, type PackageWorld } from './test-support/package-world';
import { readPackageStates } from './work-package';

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld();
});

/** Runs a refresh to the end, firing each retry wait it stops at. Waits on the timer port, never on real time. */
async function drive<T>(flight: Promise<T>): Promise<T> {
  let done = false;
  const guarded = flight.finally(() => {
    done = true;
  });
  while (!done) {
    await vi.waitFor(() => expect(done || w.timers.pending() > 0).toBe(true));
    if (!done && w.timers.pending() > 0) w.timers.fireNext();
  }
  return guarded;
}

async function snapshot(): Promise<string> {
  const packages = await w.db.query('SELECT * FROM work_package ORDER BY inspection_id');
  const cache = await w.db.query('SELECT account_key, key, etag, body, fetched_at, package_id FROM resource_cache ORDER BY account_key, key');
  return JSON.stringify({ packages, cache });
}

async function prime(...ids: string[]): Promise<void> {
  for (const id of ids) w.serve(id);
  await w.run();
  w.pkg.version = 2;
  w.pkg.requests.length = 0;
}

const versionOf = async (key: string): Promise<number | null> => {
  const body = await w.cached(key);
  return body === null ? null : ((JSON.parse(body) as { data: { v: number } }).data.v);
};
const lastError = async (id: string): Promise<string | null> => (await readPackageStates(w.db, ALICE)).find((s) => s.inspectionId === id)?.lastError ?? null;
const nonList = () => w.pkg.requests.filter((r) => r.path !== '/api/inspections');

/** Answers the request once with `answer`, then lets it through. */
function once(path: string, answer: Parameters<typeof w.pkg.overrides.set>[1]): void {
  let used = false;
  w.pkg.overrides.set(path, (req) => {
    if (used) return undefined;
    used = true;
    return answer(req);
  });
}

describe('a response that is not the server\'s answer is never stored', () => {
  const cases: [string, () => ReturnType<typeof jsonReply>, string][] = [
    ['an html page with status 200', () => jsonReply(200, '<html><body>Sign in to the wifi</body></html>', { 'content-type': 'text/html; charset=utf-8' }), 'invalid_response'],
    ['json with the wrong content type', () => jsonReply(200, { success: true, data: { v: 2 } }, { 'content-type': 'text/plain' }), 'invalid_response'],
    ['json with no content type', () => ({ ...jsonReply(200, { success: true, data: { v: 2 } }), headers: new Headers() }), 'invalid_response'],
    ['a response that sets a cookie', () => jsonReply(200, { success: true, data: { v: 2 } }, { 'set-cookie': 'session=abc' }), 'invalid_response'],
    ['an envelope without data', () => jsonReply(200, { success: true }), 'invalid_response'],
    ['an envelope that says it failed', () => jsonReply(200, { success: false, data: { v: 2 } }), 'invalid_response'],
    ['json that is not an envelope', () => jsonReply(200, { ok: true, v: 2 }), 'invalid_response'],
    ['json null', () => jsonReply(200, 'null'), 'invalid_response'],
    ['an empty 200', () => jsonReply(200, ''), 'invalid_response'],
    ['a 204', () => jsonReply(204, ''), 'invalid_response'],
    ['a 304 without anything to reuse', () => jsonReply(304, ''), 'invalid_response'],
    ['json nested far too deep', () => jsonReply(200, `{"success":true,"data":${'['.repeat(200)}1${']'.repeat(200)}}`), 'invalid_response'],
    ['an array with far too many elements', () => jsonReply(200, `{"success":true,"data":[${Array.from({ length: 60_000 }, () => '1').join(',')}]}`), 'invalid_response'],
  ];

  it.each(cases)('%s: nothing of that inspection changes, the failure is recorded, and the same inspection with a good answer is replaced', async (_name, bad, code) => {
    await prime('t1', 't2');
    w.pkg.overrides.set('/api/inspections/t1/results', bad);
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 1, failed: 1, halted: null });
    for (const key of ['/api/inspections/t1', '/api/inspections/t1/results', '/api/inspections/t1/report-data']) expect(await versionOf(key)).toBe(1);
    expect(await versionOf('/api/inspections/t2/results')).toBe(2);
    expect(await lastError('t1')).toBe(code);
    expect(await lastError('t2')).toBeNull();
    w.pkg.overrides.clear();
    const control = await w.run();
    expect(control).toMatchObject({ refreshed: 2, failed: 0 });
    expect(await versionOf('/api/inspections/t1/results')).toBe(2);
    expect(await lastError('t1')).toBeNull();
  });

  it('an oversize answer (the wrapper aborts the stream) is recorded as too large and nothing changes', async () => {
    await prime('t1');
    w.pkg.overrides.set('/api/inspections/t1/report-data', () => new AuthError('server_response_invalid'));
    const summary = await w.run();
    expect(summary.failed).toBe(1);
    expect(await versionOf('/api/inspections/t1')).toBe(1);
    expect(await lastError('t1')).toBe('too_large');
  });

  it('a body over the per-resource cap is too large even when the wrapper did not cut it', async () => {
    w = await createPackageWorld({ limits: { resourceBytes: 400 } });
    w.serve('t1');
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(200, { success: true, data: { filler: 'x'.repeat(600) } }));
    const summary = await w.run();
    expect(summary.failed).toBe(1);
    expect(await lastError('t1')).toBe('too_large');
    expect(await w.cached('/api/inspections/t1/results')).toBeNull();
  });

  it('an inspection row that names a different id is not trusted', async () => {
    await prime('t1');
    w.pkg.overrides.set('/api/inspections/t1', () => jsonReply(200, { success: true, data: { inspection: { id: 'someone-elses', status: 'scheduled' }, v: 2 } }));
    await w.run();
    expect(await versionOf('/api/inspections/t1/results')).toBe(1);
    expect(await lastError('t1')).toBe('invalid_response');
    w.pkg.overrides.set('/api/inspections/t1', () => jsonReply(200, { success: true, data: { v: 2 } }));
    await w.run();
    expect(await lastError('t1')).toBe('invalid_response');
  });

  it('a redirect (any 3xx is refused by the wrapper) is an invalid response', async () => {
    await prime('t1');
    w.pkg.overrides.set('/api/inspections/t1/results', () => new AuthError('server_redirected'));
    await w.run();
    expect(await lastError('t1')).toBe('invalid_response');
    expect(await versionOf('/api/inspections/t1/results')).toBe(1);
  });

  it('never sends a validator, even for a row that has a stored etag', async () => {
    w.serve('t1');
    await w.run();
    await w.db.run("UPDATE resource_cache SET etag = 'W/\"e1\"' WHERE key = '/api/inspections/t1/results'");
    w.pkg.requests.length = 0;
    await w.run();
    expect(w.pkg.requests.length).toBeGreaterThan(0);
    for (const request of w.pkg.requests) expect(Object.keys(request.headers).map((k) => k.toLowerCase())).not.toContain('if-none-match');
  });

  it('stores the etag a server sends, as given', async () => {
    w.serve('t1');
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(200, { success: true, data: {} }, { etag: 'W/"abc"' }));
    await w.run();
    expect((await w.db.query<{ etag: string | null }>("SELECT etag FROM resource_cache WHERE key = '/api/inspections/t1/results'"))[0]?.etag).toBe('W/"abc"');
  });
});

describe('through the real http wrapper', () => {
  it('a body over the per-resource cap is cut off while it streams and the inspection keeps its old cache', async () => {
    let oversize = false;
    const big = `{"success":true,"data":"${'x'.repeat(5000)}"}`;
    const small = (path: string) => JSON.stringify({ success: true, data: path.endsWith('/t1') ? { inspection: { id: 't1', propertyType: 'single_family' } } : { path } });
    let streamed = 0;
    const fetch = vi.fn((input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname === '/api/inspections') return Promise.resolve(new Response(JSON.stringify({ success: true, data: [{ id: 't1', status: 'scheduled', date: '2026-10-26T15:00:00.000Z', inspectorId: 'alice' }], meta: { nextCursor: null } }), { headers: { 'content-type': 'application/json' } }));
      if (url.pathname === '/api/inspections/t1/results' && oversize) {
        const chunks = big.match(/.{1,500}/g) ?? [];
        return Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                const next = chunks[streamed];
                if (next === undefined) controller.close();
                else {
                  streamed += 1;
                  controller.enqueue(new TextEncoder().encode(next));
                }
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response(small(url.pathname), { headers: { 'content-type': 'application/json' } }));
    });
    const http = createHttp({ fetch });
    const small1 = await createPackageWorld({ http, limits: { resourceBytes: 1000 } });
    small1.serve('t1');
    await small1.run();
    expect(await small1.cached('/api/inspections/t1/results')).toContain('"path"');
    oversize = true;
    const summary = await small1.run();
    expect(summary.failed).toBe(1);
    expect(streamed).toBeLessThan(10);
    expect(await small1.cached('/api/inspections/t1/results')).toContain('"path"');
    expect((await readPackageStates(small1.db, ALICE)).find((s) => s.inspectionId === 't1')?.lastError).toBe('too_large');
  });

  it('a redirect from the server is a failure, never a followed hop', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })));
    const world = await createPackageWorld({ http: createHttp({ fetch }) });
    const summary = await world.run();
    expect(summary.halted).toBe('list_failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('what the server answers with a status', () => {
  it('401, then a good session check: the request is repeated once with the refreshed session', async () => {
    w.serve('t1');
    once('/api/inspections/t1', () => jsonReply(401, { success: false, error: { code: 'UNAUTHORIZED' } }));
    const summary = await w.run();
    expect(summary.refreshed).toBe(1);
    expect(w.checkSession).toHaveBeenCalledTimes(1);
  });

  it('401 when the session cannot be recovered: the run stops, nothing is purged or changed, and the caller is told', async () => {
    await prime('t1');
    const before = await snapshot();
    w.state.session = { kind: 'relogin' };
    w.pkg.script.push(jsonReply(401, { success: false }));
    const summary = await w.run();
    expect(summary).toMatchObject({ halted: 'auth', refreshed: 0 });
    expect(w.pkg.requests).toHaveLength(1);
    expect(await snapshot()).toBe(before);
    expect(w.refreshHalts).toEqual(['auth']);
  });

  it('a second 401 after a good session check also stops the run', async () => {
    await prime('t1');
    w.pkg.overrides.set('/api/inspections/t1', () => jsonReply(401, { success: false }));
    const summary = await w.run();
    expect(summary.halted).toBe('auth');
    expect(w.checkSession).toHaveBeenCalledTimes(1);
  });

  it('426 halts the run with a fixed status and changes no data; further requests are not sent', async () => {
    await prime('t1', 't2');
    const before = await snapshot();
    w.pkg.script.push(jsonReply(426, { success: false }, {}, { upgrade: 'required' }));
    const summary = await w.run();
    expect(summary).toMatchObject({ halted: 'upgrade_required', refreshed: 0 });
    expect(w.pkg.requests).toHaveLength(1);
    expect(await snapshot()).toBe(before);
    expect(w.refreshHalts).toEqual(['upgrade_required']);
  });

  it('426 in the middle of an inspection: that inspection is not replaced and nothing else is requested', async () => {
    await prime('t1');
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(426, { success: false }));
    const summary = await w.run();
    expect(summary.halted).toBe('upgrade_required');
    expect(await versionOf('/api/inspections/t1')).toBe(1);
  });

  it.each([
    ['404', 404, 'not_found'],
    ['403', 403, 'refused'],
    ['422', 422, 'refused'],
  ])('%s on a required read fails that inspection, keeps its cache, and does not delete the package', async (_name, status, code) => {
    await prime('t1', 't2');
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(status, { success: false }));
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 1, failed: 1, halted: null });
    expect(await lastError('t1')).toBe(code);
    expect(await versionOf('/api/inspections/t1')).toBe(1);
    expect((await w.db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['t1'])).length).toBe(1);
  });

  it('404 on the inspection row itself: the cache stays and the package is not purged (only the visibility check decides that)', async () => {
    await prime('t1');
    w.pkg.overrides.set('/api/inspections/t1', () => jsonReply(404, { success: false }));
    const summary = await w.run();
    expect(summary.failed).toBe(1);
    expect(await versionOf('/api/inspections/t1/results')).toBe(1);
    expect(await lastError('t1')).toBe('not_found');
  });

  it('404 on an optional read means it does not apply: the set is replaced without it', async () => {
    w.serve('t1', { row: { propertyType: 'multi_family' } });
    w.pkg.overrides.set('/api/inspections/t1/unit-progress', () => jsonReply(404, { success: false }));
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 1, failed: 0 });
    expect(await w.cachedKeys('t1')).toEqual(['/api/inspections/t1', '/api/inspections/t1/report-data', '/api/inspections/t1/results', '/api/inspections/t1/units']);
  });

  it('a failing optional read (500 every time) fails the inspection rather than storing a mixed set', async () => {
    w = await createPackageWorld({ limits: { maxAttempts: 1 } });
    w.serve('t1', { row: { propertyType: 'multi_family' } });
    await w.run();
    w.pkg.version = 2;
    w.pkg.overrides.set('/api/inspections/t1/units', () => jsonReply(500, { success: false }));
    const summary = await w.run();
    expect(summary.failed).toBe(1);
    expect(await versionOf('/api/inspections/t1')).toBe(1);
  });
});

describe('transient trouble: backoff, Retry-After, caps', () => {
  it('a 503 is retried after a backoff wait and then succeeds, and nothing was marked empty meanwhile', async () => {
    await prime('t1');
    once('/api/inspections/t1/results', () => jsonReply(503, { success: false }));
    const flight = w.run();
    await vi.waitFor(() => expect(w.timers.pending()).toBe(1));
    expect(w.timers.delays()).toEqual([1000]);
    expect(await versionOf('/api/inspections/t1/results')).toBe(1);
    w.timers.fireNext();
    expect(await flight).toMatchObject({ refreshed: 1, failed: 0 });
    expect(await versionOf('/api/inspections/t1/results')).toBe(2);
  });

  it('a network error and a timeout are retried the same way', async () => {
    await prime('t1');
    once('/api/inspections/t1/results', () => new AuthError('server_unreachable'));
    once('/api/inspections/t1/report-data', () => new AuthError('server_timeout'));
    expect(await drive(w.run())).toMatchObject({ refreshed: 1, failed: 0 });
  });

  it('stopping while a retry wait is pending ends the run at once, without firing the timer', async () => {
    await prime('t1');
    once('/api/inspections/t1/results', () => jsonReply(503, { success: false }));
    const flight = w.run();
    await vi.waitFor(() => expect(w.timers.pending()).toBe(1));
    w.refresher.stop();
    expect(await flight).toMatchObject({ halted: 'stopped', refreshed: 0 });
    expect(w.timers.pending()).toBe(0);
    expect(await versionOf('/api/inspections/t1')).toBe(1);
  });

  it.each([
    [2000, 2000],
    [10, 1000],
    [0, 1000],
    [29_000, 29_000],
  ])('a 429 with Retry-After %i ms waits %i ms, then retries', async (retryAfterMs, waited) => {
    await prime('t1');
    once('/api/inspections/t1/results', () => jsonReply(429, { success: false }, {}, { retryAfterMs }));
    const flight = w.run();
    await vi.waitFor(() => expect(w.timers.pending()).toBe(1));
    expect(w.timers.delays()).toEqual([waited]);
    w.timers.fireNext();
    expect(await flight).toMatchObject({ refreshed: 1 });
  });

  it('a 429 that asks for more than the in-run limit stops the run: nothing is marked, nothing replaced, no wait is scheduled', async () => {
    await prime('t1', 't2');
    const before = await snapshot();
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(429, { success: false }, {}, { retryAfterMs: 3_600_000 }));
    w.pkg.overrides.set('/api/inspections/t2/results', () => jsonReply(429, { success: false }, {}, { retryAfterMs: 3_600_000 }));
    const summary = await w.run();
    expect(summary.halted).toBe('rate_limited');
    expect(w.timers.pending()).toBe(0);
    const after = JSON.parse(await snapshot()) as { cache: { key: string }[] };
    expect(after.cache.filter((r) => r.key.startsWith('$refresh_error:'))).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('a 429 holds back the other requests too, for the whole wait, and there is one wait, not one per request', async () => {
    w = await createPackageWorld({ concurrency: 3 });
    for (const id of ['a', 'b', 'c']) w.serve(id);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/b' || request.path === '/api/inspections/c') await held;
    };
    once('/api/inspections/a', () => jsonReply(429, { success: false }, {}, { retryAfterMs: 5000 }));
    const flight = w.run();
    await vi.waitFor(() => expect(w.timers.pending()).toBe(1));
    release();
    for (let i = 0; i < 300; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(nonList().map((r) => r.path).sort()).toEqual(['/api/inspections/a', '/api/inspections/b', '/api/inspections/c']);
    expect(w.timers.pending()).toBe(1);
    expect(w.timers.delays()).toEqual([5000]);
    expect(await drive(flight)).toMatchObject({ refreshed: 3 });
  });

  it('an inspection that keeps failing gives up after the attempt limit, keeps its cache, and the others are refreshed', async () => {
    await prime('t1', 't2');
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(500, { success: false }));
    const summary = await drive(w.run());
    expect(summary).toMatchObject({ refreshed: 1, failed: 1, halted: null });
    expect(w.pkg.requests.filter((r) => r.path === '/api/inspections/t1/results')).toHaveLength(3);
    expect(await versionOf('/api/inspections/t1/results')).toBe(1);
    expect(await lastError('t1')).toBe('server_error');
  });

  it('stops after a run of consecutive transport errors, and a success in between resets the count', async () => {
    w = await createPackageWorld({ concurrency: 1, limits: { maxAttempts: 1, maxConsecutiveErrors: 3 } });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) w.serve(id, { date: `2026-10-26T0${String(['a', 'b', 'c', 'd', 'e', 'f'].indexOf(id))}:00:00.000Z` });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) w.pkg.overrides.set(`/api/inspections/${id}`, () => new AuthError('server_unreachable'));
    const summary = await w.run();
    expect(summary.halted).toBe('too_many_errors');
    expect(nonList().map((r) => r.path)).toEqual(['/api/inspections/a', '/api/inspections/b', '/api/inspections/c']);
  });

  it('errors separated by a success do not add up', async () => {
    w = await createPackageWorld({ concurrency: 1, limits: { maxAttempts: 1, maxConsecutiveErrors: 3 } });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    ids.forEach((id, i) => w.serve(id, { date: `2026-10-26T0${String(i)}:00:00.000Z` }));
    for (const id of ['a', 'b', 'd', 'e']) w.pkg.overrides.set(`/api/inspections/${id}`, () => new AuthError('server_unreachable'));
    const summary = await w.run();
    expect(summary).toMatchObject({ halted: null, refreshed: 1, failed: 4 });
  });

  describe('a 404 is a valid answer from the server, so it resets the count of consecutive transport errors', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    async function runWith(middle: () => AuthError | ReturnType<typeof jsonReply>) {
      w = await createPackageWorld({ concurrency: 1, limits: { maxAttempts: 1, maxConsecutiveErrors: 3 } });
      ids.forEach((id, i) => w.serve(id, { date: `2026-10-26T0${String(i)}:00:00.000Z` }));
      for (const id of ['a', 'b', 'd', 'e']) w.pkg.overrides.set(`/api/inspections/${id}`, () => new AuthError('server_unreachable'));
      w.pkg.overrides.set('/api/inspections/c', middle);
      return w.run();
    }

    it('two errors, a 404, two errors: the run is not halted', async () => {
      const summary = await runWith(() => jsonReply(404, { success: false, error: { code: 'NOT_FOUND', message: 'gone' } }));
      expect(summary.halted).toBeNull();
      expect(nonList().map((r) => r.path).filter((path) => path.startsWith('/api/inspections/'))).toEqual(['/api/inspections/a', '/api/inspections/b', '/api/inspections/c', '/api/inspections/d', '/api/inspections/e']);
    });

    it('positive control: the same sequence with a transport error in the middle halts after three in a row', async () => {
      const summary = await runWith(() => new AuthError('server_unreachable'));
      expect(summary.halted).toBe('too_many_errors');
      expect(nonList().map((r) => r.path)).toEqual(['/api/inspections/a', '/api/inspections/b', '/api/inspections/c']);
    });
  });

  it('stops at the request cap for the run, and an inspection cut off half way is not replaced', async () => {
    w = await createPackageWorld({ concurrency: 1, limits: { maxRequests: 9 } });
    for (const id of ['a', 'b', 'c', 'd']) w.serve(id);
    const summary = await w.run();
    expect(summary.halted).toBe('request_cap');
    expect(w.pkg.requests).toHaveLength(9);
    expect(summary.requests).toBe(9);
    const complete = (await w.db.query<{ package_id: string; n: number }>("SELECT package_id, COUNT(*) AS n FROM resource_cache WHERE SUBSTR(key, 1, 5) = '/api/' GROUP BY package_id")).map((r) => r.n);
    expect(complete.every((n) => n === 3)).toBe(true);
  });
});

describe('locked, revoked, offline, signed out, stopped', () => {
  it.each([
    ['locked', () => (w.state.locked = true), 'locked'],
    ['the lock state cannot be read', () => (w.state.lockedThrows = true), 'locked'],
    ['offline', () => w.network.setQuietly(false), 'offline'],
    ['signed out', () => (w.state.account = null), 'no_account'],
  ])('%s: zero requests, the cache and the packages are untouched, and the identical state unlocked does refresh', async (_name, block, halted) => {
    await prime('t1');
    const before = await snapshot();
    block();
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 0, halted });
    expect(w.pkg.requests).toHaveLength(0);
    expect(await snapshot()).toBe(before);
    expect(w.refreshErrors).toEqual([]);
    w.state.locked = false;
    w.state.lockedThrows = false;
    w.network.setQuietly(true);
    w.state.account = ALICE;
    expect(await w.run()).toMatchObject({ refreshed: 1 });
  });

  it('a lock that arrives while an inspection is downloading: that inspection is not written and no further request is sent', async () => {
    w = await createPackageWorld({ concurrency: 1 });
    w.serve('a', { date: '2026-10-26T01:00:00.000Z' });
    w.serve('b', { date: '2026-10-26T02:00:00.000Z' });
    w.pkg.hook = (request) => {
      if (request.path === '/api/inspections/a/results') w.state.locked = true;
    };
    const summary = await w.run();
    expect(summary.halted).toBe('locked');
    expect(await w.cachedKeys('a')).toEqual([]);
    expect(w.pkg.forInspection('b')).toEqual([]);
    expect(await w.db.query('SELECT COUNT(*) AS n FROM resource_cache')).toEqual([{ n: 0 }]);
  });

  it('the account changing while a token is fetched: that request is not sent, nothing is written', async () => {
    w.serve('t1');
    let calls = 0;
    w.state.tokenFn = () => {
      calls += 1;
      if (calls === 2) w.state.account = BOB;
      return Promise.resolve(w.state.token);
    };
    const summary = await w.run();
    expect(summary.halted).toBe('no_account');
    expect(w.pkg.requests).toHaveLength(1);
    expect(await w.db.query('SELECT COUNT(*) AS n FROM work_package')).toEqual([{ n: 0 }]);
  });

  it('the account changing before the write: the downloaded set is dropped', async () => {
    w.serve('t1');
    w.pkg.hook = (request) => {
      if (request.path === '/api/inspections/t1/report-data') w.state.account = BOB;
    };
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 0, halted: 'no_account' });
    expect(await w.db.query('SELECT COUNT(*) AS n FROM resource_cache')).toEqual([{ n: 0 }]);
  });

  it('stopping during a download is terminal: nothing more is requested or written', async () => {
    w = await createPackageWorld({ concurrency: 1 });
    w.serve('a', { date: '2026-10-26T01:00:00.000Z' });
    w.serve('b', { date: '2026-10-26T02:00:00.000Z' });
    w.pkg.hook = (request) => {
      if (request.path === '/api/inspections/a/results') w.refresher.stop();
    };
    const summary = await w.run();
    expect(summary.halted).toBe('stopped');
    expect(await w.db.query('SELECT COUNT(*) AS n FROM resource_cache')).toEqual([{ n: 0 }]);
    w.pkg.requests.length = 0;
    expect(await w.run()).toMatchObject({ halted: 'stopped', refreshed: 0 });
    expect(w.pkg.requests).toHaveLength(0);
  });
});

describe('races with a purge and with another refresh', () => {
  it('a purge that finishes while the download is running: nothing is written, and the same run without a purge writes', async () => {
    w.serve('t1');
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/t1/results') await w.db.run('DELETE FROM work_package WHERE inspection_id = ?', ['t1']);
    };
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 0, skipped: 1, failed: 0 });
    expect(await w.db.query('SELECT COUNT(*) AS n FROM resource_cache WHERE package_id = ?', ['t1'])).toEqual([{ n: 0 }]);
    expect(await w.db.query('SELECT COUNT(*) AS n FROM work_package')).toEqual([{ n: 0 }]);
    w.pkg.hook = null;
    expect(await w.run()).toMatchObject({ refreshed: 1 });
  });

  it('a purge that has only set its tombstone keeps the old rows and gets no new ones', async () => {
    await prime('t1');
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/t1/results') await w.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['t1']);
    };
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(await versionOf('/api/inspections/t1')).toBe(1);
    expect(await w.db.query('SELECT package_gen FROM work_package')).toEqual([{ package_gen: 1 }]);
    expect(await w.db.query("SELECT 1 FROM resource_cache WHERE SUBSTR(key, 1, 15) = '$refresh_error:'")).toEqual([]);
  });

  it('a newer refresh that finished first wins over this older one', async () => {
    await prime('t1');
    w.pkg.hook = async (request) => {
      if (request.path === '/api/inspections/t1/results') {
        await replaceInspectionResources(w.db, { accountKey: ALICE_KEY, inspectionId: 't1', packageGen: 1, resources: new Map([['/api/inspections/t1', { body: '{"success":true,"data":{"v":99}}', fetchedAt: 1 }]]), refreshedAt: 1 });
      }
    };
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(await w.cached('/api/inspections/t1')).toBe('{"success":true,"data":{"v":99}}');
    expect(await w.cached('/api/inspections/t1/results')).toBeNull();
  });
});

describe('the replacement is atomic per inspection', () => {
  it('a storage failure in the middle of the second inspection leaves the first replaced and the second exactly as it was', async () => {
    w = await createPackageWorld({ concurrency: 1 });
    w.serve('a', { date: '2026-10-26T01:00:00.000Z' });
    w.serve('b', { date: '2026-10-26T02:00:00.000Z' });
    await w.run();
    w.pkg.version = 2;
    const flaky = failingDb(w.db, /INSERT INTO resource_cache/, 5);
    const summary = await w.build({ db: flaky }).refresh({ reason: 'manual' });
    expect(flaky.failures()).toBe(1);
    expect(summary).toMatchObject({ refreshed: 1, failed: 1 });
    for (const key of ['/api/inspections/a', '/api/inspections/a/results', '/api/inspections/a/report-data']) expect(await versionOf(key)).toBe(2);
    for (const key of ['/api/inspections/b', '/api/inspections/b/results', '/api/inspections/b/report-data']) expect(await versionOf(key)).toBe(1);
    expect(await lastError('b')).toBe('storage_failed');
    expect(w.refreshErrors).toHaveLength(1);
  });

  it('the global reads are replaced as one set and a failure keeps the old set', async () => {
    w.serve('t1');
    await w.run();
    w.pkg.version = 2;
    // Three inserts for the inspection, then the third insert of the five global reads.
    const flaky = failingDb(w.db, /INSERT INTO resource_cache/, 6);
    const summary = await w.build({ db: flaky }).refresh({ reason: 'manual' });
    expect(summary.globalRefreshed).toBe(false);
    expect(await versionOf('/api/tags')).toBe(1);
    expect(await versionOf('/api/session/context')).toBe(1);
    expect(await w.run()).toMatchObject({ globalRefreshed: true });
    expect(await versionOf('/api/tags')).toBe(2);
  });

  it('a failing global read keeps the previous global set whole', async () => {
    w = await createPackageWorld({ limits: { maxAttempts: 1 } });
    w.serve('t1');
    await w.run();
    w.pkg.version = 2;
    w.pkg.overrides.set('/api/recommendations', () => jsonReply(500, { success: false }));
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 1, globalRefreshed: false });
    expect(await versionOf('/api/tags')).toBe(1);
    expect(await versionOf('/api/recommendations')).toBe(1);
  });
});

describe('what the person and the logs may see', () => {
  it('failures carry fixed codes only: no token, url, host or server text reaches an error, a state or a summary', async () => {
    w = await createPackageWorld({ limits: { maxAttempts: 1 } });
    w.serve('t1');
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(500, { success: false, error: { code: 'X', message: 'SECRET-SERVER-TEXT https://oi.example.test/private' } }));
    const summary = await w.run();
    const dump = JSON.stringify([summary, await readPackageStates(w.db, ALICE), w.refreshErrors, w.refreshHalts, await w.db.query('SELECT key, body FROM resource_cache WHERE SUBSTR(key, 1, 15) = ?', ['$refresh_error:'])]);
    expect(dump).not.toContain('SECRET-SERVER-TEXT');
    expect(dump).not.toContain('access-token-secret');
    expect(dump).not.toContain('oi.example.test');
    expect(dump).toContain('server_error');
  });

  it('records an error only for a package that exists', async () => {
    w = await createPackageWorld({ limits: { maxAttempts: 1 } });
    w.serve('t1');
    w.pkg.overrides.set('/api/inspections/t1/results', async () => {
      await w.db.run('DELETE FROM work_package WHERE inspection_id = ?', ['t1']);
      return jsonReply(500, { success: false });
    });
    await w.run();
    expect(await w.db.query("SELECT 1 FROM resource_cache WHERE SUBSTR(key, 1, 15) = '$refresh_error:'")).toEqual([]);
  });

  it('the work list reads timestamps from the package row', async () => {
    w.serve('t1');
    await w.run();
    expect((await readPackageStates(w.db, ALICE))[0]).toMatchObject({ inspectionId: 't1', lastRefreshedAt: NOW });
  });
});
