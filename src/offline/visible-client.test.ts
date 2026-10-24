import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth/errors';
import type { Http, HttpRequest, HttpResponse } from '../auth/http';
import type { SessionCheck } from '../auth/tokens';
import { createManualClock } from '../platform/clock';
import { createSessionProbe, createVisibleClient, type VisibleOutcome } from './visible-client';

const ORIGIN = 'https://oi.example.test';
const URL_VISIBLE = `${ORIGIN}/api/client/inspections/visible`;
const TOKEN = 'access-token-secret';

function json(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }, extra: Partial<HttpResponse> = {}): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, headers: new Headers(headers), text, json: body, retryAfterMs: null, upgrade: null, serverDateMs: null, ...extra };
}

const visibleReply = (visible: unknown): HttpResponse => json(200, { success: true, data: { visible } });
const limitReply = (limit: number): HttpResponse => json(422, { success: false, error: { code: 'UNPROCESSABLE_ENTITY', message: 'too many', details: { limits: { ids: limit } } } });

type Answer = HttpResponse | Error | ((ids: string[], n: number) => HttpResponse | Error);

interface Rig {
  http: Http;
  requests: HttpRequest[];
  sentIds: string[][];
  /** Answers consumed in order; when empty the server echoes the ids it was asked about that exist. */
  script: Answer[];
  existing: Set<string> | null;
}

function rig(): Rig {
  const state: Rig = {
    requests: [],
    sentIds: [],
    script: [],
    existing: null,
    http: {
      request: (req) => {
        state.requests.push(req);
        const ids = (JSON.parse(req.body ?? '{}') as { ids: string[] }).ids;
        state.sentIds.push(ids);
        const next = state.script.shift();
        const answer = typeof next === 'function' ? next(ids, state.requests.length) : next;
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer ?? visibleReply(ids.filter((id) => state.existing === null || state.existing.has(id))));
      },
    },
  };
  return state;
}

function makeClient(r: Rig, overrides: { token?: () => Promise<string | null>; checkSession?: () => Promise<SessionCheck> } = {}) {
  const tokens = {
    getAccessToken: vi.fn(overrides.token ?? (() => Promise.resolve<string | null>(TOKEN))),
    checkSession: vi.fn(overrides.checkSession ?? (() => Promise.resolve<SessionCheck>({ kind: 'ok', session: { userId: 'alice', tenantId: 'tenant-1', role: 'inspector', offlineMaxDays: 7 } }))),
  };
  const client = createVisibleClient({ http: r.http, tokens, origin: ORIGIN, clientHeaders: { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' } });
  return { client, tokens };
}

const headersOf = (req: HttpRequest): Record<string, string> => req.headers ?? {};

const ids = (n: number, prefix = 'insp'): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);

function ok(outcome: VisibleOutcome): Set<string> {
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.visible as Set<string>;
}

describe('the request', () => {
  it('posts the ids and nothing else to the pinned origin, with the bearer token and the client headers', async () => {
    const r = rig();
    const { client } = makeClient(r);
    const outcome = await client.check(['a', 'b']);
    expect([...ok(outcome)].sort()).toEqual(['a', 'b']);
    const req = r.requests[0] as HttpRequest;
    expect(req.url).toBe(URL_VISIBLE);
    expect(req.method).toBe('POST');
    expect(headersOf(req)).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' });
    expect(Object.keys(JSON.parse(req.body ?? '{}') as object)).toEqual(['ids']);
    expect(Object.keys(headersOf(req)).some((h) => /cookie/i.test(h))).toBe(false);
  });

  it('sends each id once', async () => {
    const r = rig();
    await makeClient(r).client.check(['a', 'b', 'a', 'b', 'c']);
    expect(r.sentIds).toEqual([['a', 'b', 'c']]);
  });

  it('a client header cannot replace the credential or the content type', async () => {
    const r = rig();
    const client = createVisibleClient({
      http: r.http,
      tokens: { getAccessToken: () => Promise.resolve(TOKEN), checkSession: () => Promise.resolve({ kind: 'signed_out' }) },
      origin: ORIGIN,
      clientHeaders: { authorization: 'Bearer evil', Cookie: 'x=1', 'Content-Type': 'text/plain', 'X-Client-Version': '1' },
    });
    await client.check(['a']);
    const req = r.requests[0] as HttpRequest;
    expect(headersOf(req).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headersOf(req)['content-type']).toBe('application/json');
    expect(Object.keys(headersOf(req)).map((h) => h.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(headersOf(req)).filter((h) => h.toLowerCase() === 'content-type')).toHaveLength(1);
  });

  it('refuses an id the server would refuse, without sending anything', async () => {
    const r = rig();
    const outcome = await makeClient(r).client.check(['good-1', 'bad id']);
    expect(outcome).toEqual({ kind: 'invalid', reason: 'bad_ids' });
    expect(r.requests).toHaveLength(0);
  });

  it('asks nothing when there is nothing to ask', async () => {
    const r = rig();
    const outcome = await makeClient(r).client.check([]);
    expect(ok(outcome).size).toBe(0);
    expect(r.requests).toHaveLength(0);
  });
});

describe('batches', () => {
  it.each([
    [1, [1]],
    [299, [299]],
    [300, [300]],
    [301, [300, 1]],
    [600, [300, 300]],
    [601, [300, 300, 1]],
  ])('%i ids go out as batches %j', async (count, expected) => {
    const r = rig();
    const outcome = await makeClient(r).client.check(ids(count));
    expect(r.sentIds.map((batch) => batch.length)).toEqual(expected);
    expect(ok(outcome).size).toBe(count);
  });

  it('the visible set is the union of all batches', async () => {
    const r = rig();
    r.existing = new Set(['insp-0', 'insp-300', 'insp-350']);
    const outcome = await makeClient(r).client.check(ids(351));
    expect([...ok(outcome)].sort()).toEqual(['insp-0', 'insp-300', 'insp-350']);
  });

  it('a smaller batch size can be asked for', async () => {
    const r = rig();
    await createVisibleClient({ http: r.http, tokens: { getAccessToken: () => Promise.resolve(TOKEN), checkSession: () => Promise.resolve({ kind: 'signed_out' }) }, origin: ORIGIN }).check(ids(25), { maxBatch: 10 });
    expect(r.sentIds.map((b) => b.length)).toEqual([10, 10, 5]);
  });

  it('a failing second batch ends the whole run: nothing is reported as visible or missing', async () => {
    const r = rig();
    r.script = [(batch) => visibleReply(batch), json(500, { success: false })];
    const outcome = await makeClient(r).client.check(ids(301));
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'server' });
    expect('visible' in outcome).toBe(false);
    expect(r.requests).toHaveLength(2);
  });

  it('control: the same two batches both answered give the full set', async () => {
    const r = rig();
    const outcome = await makeClient(r).client.check(ids(301));
    expect(ok(outcome).size).toBe(301);
  });

  it('stops at the request cap instead of looping', async () => {
    const r = rig();
    const outcome = await createVisibleClient({ http: r.http, tokens: { getAccessToken: () => Promise.resolve(TOKEN), checkSession: () => Promise.resolve({ kind: 'signed_out' }) }, origin: ORIGIN }).check(ids(50), { maxBatch: 5, maxRequests: 3 });
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'too_many_requests' });
    expect(r.requests).toHaveLength(3);
  });
});

describe('a limit the server states', () => {
  it('shrinks the batch once to the stated limit and asks again, then finishes at that size', async () => {
    const r = rig();
    r.script = [limitReply(100)];
    const outcome = await makeClient(r).client.check(ids(250));
    expect(r.sentIds.map((b) => b.length)).toEqual([250, 100, 100, 50]);
    expect(ok(outcome).size).toBe(250);
  });

  it('control: without a 422 the same ids go out as one batch', async () => {
    const r = rig();
    await makeClient(r).client.check(ids(250));
    expect(r.sentIds.map((b) => b.length)).toEqual([250]);
  });

  it('gives up when the second answer is a 422 as well: it asks once more and no more', async () => {
    const r = rig();
    r.script = [limitReply(100), limitReply(10)];
    const outcome = await makeClient(r).client.check(ids(250));
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'limit' });
    expect(r.requests).toHaveLength(2);
  });

  it.each([
    ['no limit stated', json(422, { success: false, error: { code: 'X', message: 'm' } })],
    ['a limit that is not smaller than the batch', limitReply(20)],
    ['a limit above anything the engine allows', limitReply(500)],
    ['a limit of zero', limitReply(0)],
    ['a limit that is not a number', json(422, { success: false, error: { details: { limits: { ids: '5' } } } })],
    ['a body that carries the answer instead', json(422, { success: true, data: { visible: [] } })],
  ])('a 422 with %s is a failure, never data', async (_name, reply) => {
    const r = rig();
    r.script = [reply];
    const outcome = await makeClient(r).client.check(ids(20));
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'limit' });
    expect(r.requests).toHaveLength(1);
  });
});

describe('answers that are not data', () => {
  it('a 403 means this role cannot ask: unavailable, not an error and not a reason to remove anything', async () => {
    const r = rig();
    r.script = [json(403, { success: false, error: { code: 'FORBIDDEN', message: 'no' } })];
    expect(await makeClient(r).client.check(['a'])).toEqual({ kind: 'unavailable', reason: 'role' });
  });

  it('a 426 halts', async () => {
    const r = rig();
    r.script = [json(426, { success: false })];
    expect(await makeClient(r).client.check(['a'])).toMatchObject({ kind: 'halt' });
  });

  it.each([
    [429, 'rate_limited'],
    [500, 'server'],
    [502, 'server'],
    [503, 'server'],
    [408, 'server'],
    [400, 'rejected'],
    [404, 'rejected'],
  ])('a %i is a failure of the whole run (%s)', async (status, reason) => {
    const r = rig();
    r.script = [json(status, { success: false })];
    const outcome = await makeClient(r).client.check(['a']);
    expect(outcome).toMatchObject({ kind: 'failed', reason });
  });

  it('carries the server wait on a 429', async () => {
    const r = rig();
    r.script = [json(429, { success: false }, {}, { retryAfterMs: 7000 })];
    expect(await makeClient(r).client.check(['a'])).toMatchObject({ kind: 'failed', reason: 'rate_limited', retryAfterMs: 7000 });
  });

  it.each([
    [new AuthError('server_timeout'), 'timeout'],
    [new AuthError('server_unreachable'), 'network'],
    [new AuthError('server_redirected'), 'network'],
    [new Error('socket hang up with a secret in it'), 'network'],
  ])('a thrown %s is a failure (%s) and says nothing else', async (error, reason) => {
    const r = rig();
    r.script = [error];
    const outcome = await makeClient(r).client.check(['a']);
    expect(outcome).toEqual({ kind: 'failed', reason, retryAfterMs: null });
  });

  it('control: the same request answered well is data', async () => {
    expect(ok(await makeClient(rig()).client.check(['a'])).has('a')).toBe(true);
  });
});

describe('a 200 that is not the server answer', () => {
  const batch = ['aa', 'bb', 'cc'];
  const good = (visible: unknown): HttpResponse => visibleReply(visible);

  it.each<[string, HttpResponse]>([
    ['an empty object', json(200, {})],
    ['null', json(200, 'null', undefined, { json: null })],
    ['an array', json(200, [])],
    ['success false', json(200, { success: false, data: { visible: ['aa'] } })],
    ['success as a string', json(200, { success: 'true', data: { visible: ['aa'] } })],
    ['no data', json(200, { success: true })],
    ['data as an array', json(200, { success: true, data: [] })],
    ['no visible list', json(200, { success: true, data: {} })],
    ['visible as an object', json(200, { success: true, data: { visible: { aa: true } } })],
    ['visible as a string', json(200, { success: true, data: { visible: 'aa' } })],
    ['a number in the list', good(['aa', 7])],
    ['null in the list', good(['aa', null])],
    ['an id outside the charset', good(['aa', 'b b'])],
    ['an id that is too long', good(['a'.repeat(65)])],
    ['an empty id', good([''])],
    ['a duplicate id', good(['aa', 'aa'])],
    ['an id that was not asked for', good(['aa', 'zz'])],
    ['more ids than were asked', good(['aa', 'bb', 'cc', 'dd'])],
    ['html with a 200', json(200, '<html>captive portal</html>', { 'content-type': 'text/html' }, { json: undefined })],
    ['a json body without a content type', json(200, { success: true, data: { visible: ['aa'] } }, {})],
    ['a plain text content type', json(200, { success: true, data: { visible: ['aa'] } }, { 'content-type': 'text/plain' })],
    ['application/problem+json, which is not application/json', json(200, { success: true, data: { visible: ['aa'] } }, { 'content-type': 'application/problem+json' })],
    ['text/json, which is not application/json', json(200, { success: true, data: { visible: ['aa'] } }, { 'content-type': 'text/json' })],
    ['a 204', json(204, '', {}, { json: undefined })],
  ])('%s is invalid and is never read as everything missing', async (_name, reply) => {
    const r = rig();
    r.script = [reply];
    const outcome = await makeClient(r).client.check(batch);
    expect(outcome).toEqual({ kind: 'invalid', reason: 'bad_response' });
  });

  it('control: the exact shape, with some of the asked ids, is data (the others are simply not visible)', async () => {
    const r = rig();
    r.script = [good(['aa', 'cc'])];
    expect([...ok(await makeClient(r).client.check(batch))].sort()).toEqual(['aa', 'cc']);
  });

  it('control: an empty list in the exact shape is a real answer: nothing is visible', async () => {
    const r = rig();
    r.script = [good([])];
    expect(ok(await makeClient(r).client.check(batch)).size).toBe(0);
  });

  it('an id of the first batch inside the answer to the second batch is a superset, and invalid', async () => {
    const r = rig();
    r.script = [(b) => visibleReply(b), (b) => visibleReply([...b, 'insp-0'])];
    const outcome = await makeClient(r).client.check(ids(301));
    expect(outcome).toEqual({ kind: 'invalid', reason: 'bad_response' });
  });

  it('an invalid second batch discards the valid first one', async () => {
    const r = rig();
    r.script = [(b) => visibleReply(b), json(200, {})];
    const outcome = await makeClient(r).client.check(ids(301));
    expect(outcome.kind).toBe('invalid');
    expect('visible' in outcome).toBe(false);
  });
});

describe('authentication', () => {
  it('no access token: auth, without a request', async () => {
    const r = rig();
    const { client } = makeClient(r, { token: () => Promise.resolve(null) });
    expect(await client.check(['a'])).toEqual({ kind: 'auth' });
    expect(r.requests).toHaveLength(0);
  });

  it('a throwing token read is a failure, not a sign-out', async () => {
    const r = rig();
    const { client } = makeClient(r, { token: () => Promise.reject(new Error('store down')) });
    expect(await client.check(['a'])).toMatchObject({ kind: 'failed', reason: 'network' });
  });

  it.each<[string, SessionCheck]>([
    ['relogin', { kind: 'relogin' }],
    ['signed out', { kind: 'signed_out' }],
  ])('a 401 whose session check says %s is auth', async (_name, check) => {
    const r = rig();
    r.script = [json(401, { success: false })];
    const { client, tokens } = makeClient(r, { checkSession: () => Promise.resolve(check) });
    expect(await client.check(['a'])).toEqual({ kind: 'auth' });
    expect(tokens.checkSession).toHaveBeenCalledTimes(1);
    expect(r.requests).toHaveLength(1);
  });

  it('a 401 whose session check says to retry later is a failure with that wait', async () => {
    const r = rig();
    r.script = [json(401, { success: false })];
    const { client } = makeClient(r, { checkSession: () => Promise.resolve({ kind: 'retry', reason: 'server', retryAfterMs: 4000 }) });
    expect(await client.check(['a'])).toEqual({ kind: 'failed', reason: 'auth_retry', retryAfterMs: 4000 });
  });

  it('control: a 401 whose session is still fine is asked once more with the fresh token and then answers', async () => {
    const r = rig();
    r.script = [json(401, { success: false })];
    let n = 0;
    const { client } = makeClient(r, { token: () => Promise.resolve(`token-${String((n += 1))}`) });
    expect([...ok(await client.check(['a']))]).toEqual(['a']);
    expect(r.requests.map((q) => q.headers?.Authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('a second 401 is auth: there is no third attempt', async () => {
    const r = rig();
    r.script = [json(401, { success: false }), json(401, { success: false })];
    expect(await makeClient(r).client.check(['a'])).toEqual({ kind: 'auth' });
    expect(r.requests).toHaveLength(2);
  });
});

describe('the gate: lock, revocation and the lease are checked before every request', () => {
  it('a closed gate means no request at all', async () => {
    const r = rig();
    expect(await makeClient(r).client.check(['a'], { gate: () => false })).toEqual({ kind: 'blocked' });
    expect(r.requests).toHaveLength(0);
  });

  it('control: an open gate lets the same request through', async () => {
    const r = rig();
    expect(ok(await makeClient(r).client.check(['a'], { gate: () => true })).has('a')).toBe(true);
  });

  it('a gate that closes between two batches stops the run after the first', async () => {
    const r = rig();
    let calls = 0;
    const outcome = await makeClient(r).client.check(ids(301), { gate: () => (calls += 1) <= 1 });
    expect(outcome).toEqual({ kind: 'blocked' });
    expect(r.requests).toHaveLength(1);
  });

  it('a gate that throws is closed', async () => {
    const r = rig();
    expect(await makeClient(r).client.check(['a'], { gate: () => Promise.reject(new Error('lock unreadable')) })).toEqual({ kind: 'blocked' });
    expect(r.requests).toHaveLength(0);
  });

  it('is asked after the token is fetched: a lock that arrives while the token is being read stops the request', async () => {
    const r = rig();
    let locked = false;
    const { client } = makeClient(r, {
      token: () => {
        locked = true;
        return Promise.resolve(TOKEN);
      },
    });
    expect(await client.check(['a'], { gate: () => !locked })).toEqual({ kind: 'blocked' });
    expect(r.requests).toHaveLength(0);
  });
});

describe('the time budget', () => {
  it('stops before a request that would start after the deadline', async () => {
    const r = rig();
    const clock = createManualClock(1000);
    const outcome = await makeClient(r).client.check(ids(301), {
      clock,
      deadlineAt: 2000,
      gate: () => {
        clock.advance(1500);
        return true;
      },
    });
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'time_budget' });
    expect(r.requests).toHaveLength(1);
  });

  it('control: the same run inside the deadline completes', async () => {
    const r = rig();
    const clock = createManualClock(1000);
    const outcome = await makeClient(r).client.check(ids(301), { clock, deadlineAt: 1_000_000 });
    expect(ok(outcome).size).toBe(301);
  });
});

describe('what an outcome may contain', () => {
  it('never the token, the ids or server wording', async () => {
    const r = rig();
    r.script = [json(500, { success: false, error: { message: 'secret server wording' } })];
    const outcome = await makeClient(r).client.check(['very-private-id']);
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('very-private-id');
    expect(text).not.toContain('secret server wording');
  });
});

describe('the session probe', () => {
  const sessionReply = (userId = 'alice', tenantId = 'tenant-1'): HttpResponse => json(200, { success: true, data: { userId, tenantId, role: 'inspector', offlineMaxDays: 7 } });

  function probeWith(script: Answer[], overrides: Parameters<typeof makeClient>[1] = {}) {
    const r = rig();
    r.script = script;
    const tokens = {
      getAccessToken: vi.fn(overrides.token ?? (() => Promise.resolve<string | null>(TOKEN))),
      checkSession: vi.fn(overrides.checkSession ?? (() => Promise.resolve<SessionCheck>({ kind: 'ok', session: { userId: 'alice', tenantId: 'tenant-1', role: 'inspector', offlineMaxDays: 7 } }))),
    };
    const probe = createSessionProbe({ http: r.http, tokens, origin: ORIGIN });
    return { r, probe, tokens };
  }

  it('returns the identity the server sees', async () => {
    const { r, probe } = probeWith([sessionReply('bob', 'tenant-2')]);
    expect(await probe.check()).toEqual({ kind: 'ok', userId: 'bob', tenantId: 'tenant-2', role: 'inspector' });
    expect(r.requests[0]?.url).toBe(`${ORIGIN}/api/client/session`);
    expect(r.requests[0]?.method).toBe('GET');
  });

  it('a body that is not a session is invalid', async () => {
    const { probe } = probeWith([json(200, { success: true, data: {} })]);
    expect(await probe.check()).toEqual({ kind: 'invalid' });
  });

  it('a network failure is a failure', async () => {
    const { probe } = probeWith([new AuthError('server_unreachable')]);
    expect(await probe.check()).toEqual({ kind: 'failed' });
  });

  it('no token is auth', async () => {
    const { probe } = probeWith([], { token: () => Promise.resolve(null) });
    expect(await probe.check()).toEqual({ kind: 'auth' });
  });

  it('a 401 that the session check confirms is auth; one it can repair is asked again', async () => {
    const confirmed = probeWith([json(401, {})], { checkSession: () => Promise.resolve({ kind: 'relogin' }) });
    expect(await confirmed.probe.check()).toEqual({ kind: 'auth' });
    const repaired = probeWith([json(401, {}), sessionReply()]);
    expect(await repaired.probe.check()).toMatchObject({ kind: 'ok', userId: 'alice' });
  });

  it('a 401 twice is auth', async () => {
    const { probe } = probeWith([json(401, {}), json(401, {})]);
    expect(await probe.check()).toEqual({ kind: 'auth' });
  });

  it('a 401 whose check says retry later is a failure', async () => {
    const { probe } = probeWith([json(401, {})], { checkSession: () => Promise.resolve({ kind: 'retry', reason: 'server', retryAfterMs: 10 }) });
    expect(await probe.check()).toEqual({ kind: 'failed' });
  });
});
