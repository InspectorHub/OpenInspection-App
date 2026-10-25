import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { createManualClock, type ManualClock } from '../platform/clock';
import { createHttp, type FetchLike } from './http';
import { refreshTokenKey } from './server-config';
import { createMemorySecureStore } from './test-support/memory-secure-store';
import { createTokenManager, type TokenManager } from './tokens';

beforeEach(installStrictGlobals);
afterEach(restoreGlobals);

const ORIGIN = 'https://oi.example.test';
const SESSION_BODY = JSON.stringify({ success: true, data: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } });
const TOKEN_BODY = JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'bearer', expires_in: 3600 });

type Route = (url: string) => Response | Promise<Response>;

interface Posts {
  token: number;
  session: number;
}

function manager(route: Route, options: { clock?: ManualClock; brokenStore?: boolean } = {}): { m: TokenManager; posts: Posts; clock: ManualClock } {
  const posts: Posts = { token: 0, session: 0 };
  const fetchLike: FetchLike = (url) => {
    if (url.endsWith('/oauth/token')) posts.token += 1;
    if (url.endsWith('/api/client/session')) posts.session += 1;
    return Promise.resolve(route(url));
  };
  const memory = createMemorySecureStore({ [refreshTokenKey(ORIGIN)]: 'stored-refresh' });
  const store = options.brokenStore === true ? { ...memory, get: () => Promise.reject(new Error('keystore unavailable')) } : memory;
  const clock = options.clock ?? createManualClock(1_000_000);
  const m = createTokenManager({ http: createHttp({ fetch: fetchLike }), store, clock, getClientId: () => Promise.resolve('client-1'), random: () => 1 });
  return { m, posts, clock };
}

const json = (status: number, body: string): Response => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const refused: Route = () => {
  throw new TypeError('Failed to fetch');
};

describe('every retry says what it shows about the server', () => {
  it.each([
    ['500', () => json(500, '{}'), 'answered'],
    ['502', () => json(502, '<html>'), 'answered'],
    ['503', () => json(503, '{}'), 'answered'],
    ['429', () => json(429, '{}'), 'answered'],
    ['403', () => json(403, '{}'), 'answered'],
    ['a 400 that is not invalid_grant', () => json(400, '{"error":"invalid_request"}'), 'answered'],
    ['a 200 that is not a token', () => json(200, 'not json'), 'answered'],
    ['426', () => json(426, '{}'), 'upgrade_required'],
    ['a refused connection', refused, 'no_answer'],
  ] as const)('%s is %s', async (_name, route, cause) => {
    const { m } = manager(route);
    expect(await m.refresh(ORIGIN)).toMatchObject({ kind: 'retry', cause });
  });

  it('a broken secure store is local', async () => {
    const { m } = manager(() => json(200, TOKEN_BODY), { brokenStore: true });
    expect(await m.refresh(ORIGIN)).toMatchObject({ kind: 'retry', reason: 'storage', cause: 'local' });
  });

  it.each([
    ['a refused connection', refused, 'no_answer'],
    ['a 503', () => json(503, '{}'), 'answered'],
    ['a 426', () => json(426, '{}'), 'upgrade_required'],
  ] as const)('a back-off that began with %s keeps that cause', async (_name, route, cause) => {
    const { m } = manager(route);
    await m.refresh(ORIGIN);
    expect(await m.refresh(ORIGIN)).toMatchObject({ kind: 'retry', reason: 'backoff', cause });
  });
});

describe('the error getAccessToken throws', () => {
  it.each([
    ['a 429', () => json(429, '{}'), 'server_response_invalid', 'answered'],
    ['a 503', () => json(503, '{}'), 'server_response_invalid', 'answered'],
    ['a 426', () => json(426, '{}'), 'server_response_invalid', 'upgrade_required'],
    ['a refused connection', refused, 'server_unreachable', 'no_answer'],
  ] as const)('%s: code %s, cause %s', async (_name, route, code, retryCause) => {
    const { m } = manager(route);
    await expect(m.getAccessToken(ORIGIN)).rejects.toMatchObject({ code, retryCause });
  });
});

describe('checkSession classifies a failed session call by what happened', () => {
  async function checked(route: Route) {
    const { m } = manager((url) => (url.endsWith('/oauth/token') ? json(200, TOKEN_BODY) : route(url)));
    return m.checkSession(ORIGIN);
  }

  it('a connection failure is "network" and no answer', async () => {
    expect(await checked(refused)).toMatchObject({ kind: 'retry', reason: 'network', cause: 'no_answer' });
  });

  it('a session call that gets no reply in time is "timeout" and no answer', async () => {
    const hanging = createTokenManager({
      http: createHttp({
        defaultTimeoutMs: 20,
        fetch: (url, init) =>
          url.endsWith('/oauth/token')
            ? Promise.resolve(json(200, TOKEN_BODY))
            : new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
              }),
      }),
      store: createMemorySecureStore({ [refreshTokenKey(ORIGIN)]: 'stored-refresh' }),
      clock: createManualClock(1_000_000),
      getClientId: () => Promise.resolve('client-1'),
      random: () => 1,
    });
    expect(await hanging.checkSession(ORIGIN)).toMatchObject({ kind: 'retry', reason: 'timeout', cause: 'no_answer' });
  });

  it('a redirect (the server answered) is not "network"', async () => {
    expect(await checked(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/' } }))).toMatchObject({ kind: 'retry', reason: 'malformed', cause: 'answered' });
  });

  it('an answer too large to read is not "network"', async () => {
    expect(await checked(() => new Response('x'.repeat(200_000), { status: 200, headers: { 'content-type': 'application/json' } }))).toMatchObject({ kind: 'retry', reason: 'malformed', cause: 'answered' });
  });

  it('control: a good answer is ok', async () => {
    expect(await checked(() => json(200, SESSION_BODY))).toMatchObject({ kind: 'ok' });
  });
});

describe('a refused refresh forgets the cached access token', () => {
  it('after invalid_grant the old access token is never handed out again, even if the clock goes back', async () => {
    let revoked = false;
    const route: Route = (url) => {
      if (url.endsWith('/oauth/token')) return revoked ? json(400, '{"error":"invalid_grant"}') : json(200, TOKEN_BODY);
      return json(200, SESSION_BODY);
    };
    const { m, clock } = manager(route);
    expect(await m.getAccessToken(ORIGIN)).toBe('fresh-access');
    revoked = true;
    clock.advance(3_600_000 - 30_000);
    expect(await m.getAccessToken(ORIGIN)).toBeNull();
    clock.advance(-(3_600_000 - 30_000));
    expect(await m.getAccessToken(ORIGIN)).toBeNull();
    expect(await m.getState(ORIGIN)).toBe('relogin_required');
  });

  it('the same after a session that stays 401 once refreshed', async () => {
    const route: Route = (url) => (url.endsWith('/oauth/token') ? json(200, TOKEN_BODY) : json(401, '{}'));
    const { m, posts } = manager(route);
    expect(await m.checkSession(ORIGIN)).toEqual({ kind: 'relogin' });
    const before = posts.token;
    expect(await m.getAccessToken(ORIGIN)).toBe('fresh-access');
    expect(posts.token).toBe(before + 1);
  });

  it('control: without a refusal the cached token is handed out without asking the server again', async () => {
    const { m, posts } = manager(() => json(200, TOKEN_BODY));
    await m.getAccessToken(ORIGIN);
    await m.getAccessToken(ORIGIN);
    expect(posts.token).toBe(1);
  });
});
