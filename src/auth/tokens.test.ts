import { beforeEach, describe, expect, it } from 'vitest';
import { createManualClock, type ManualClock } from '../platform/clock';
import { createHttp, type FetchLike } from './http';
import { backoffMs, classifyTokenFailure, createTokenManager, type TokenManager } from './tokens';
import { refreshTokenKey } from './server-config';
import { createFakeServer, s256, type FakeServer } from './test-support/fake-server';
import { createMemorySecureStore, type MemorySecureStore } from './test-support/memory-secure-store';

const REDIRECT = 'io.inspectorhub.app:/oauth/callback';

interface Rig {
  server: FakeServer;
  store: MemorySecureStore;
  clock: ManualClock;
  manager: TokenManager;
  clientId: string;
  origin: string;
  fetch: FetchLike;
}

/** Registers and signs in directly against the fake, then hands the tokens to a manager. */
async function rig(options: { server?: FakeServer; store?: MemorySecureStore; clock?: ManualClock; fetch?: FetchLike } = {}): Promise<Rig> {
  const server = options.server ?? createFakeServer();
  const fetch = options.fetch ?? server.fetch;
  const store = options.store ?? createMemorySecureStore();
  const clock = options.clock ?? createManualClock(1_000_000);
  const http = createHttp({ fetch });
  const reg = await http.request({
    url: `${server.origin}/oauth/register`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  const clientId = (reg.json as { client_id: string }).client_id;
  const verifier = 'v'.repeat(43);
  const challenge = await s256(verifier);
  const callback = await server.authorize(
    `${server.origin}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'native', code_challenge: challenge, code_challenge_method: 'S256', state: 's' }).toString()}`,
  );
  const code = new URL(callback).searchParams.get('code') ?? '';
  const tok = await http.request({
    url: `${server.origin}/oauth/token`,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }).toString(),
  });
  const body = tok.json as { access_token: string; refresh_token: string; expires_in: number };
  const manager = createTokenManager({ http, store, clock, getClientId: () => Promise.resolve(clientId), random: () => 1 });
  await manager.adopt(server.origin, { accessToken: body.access_token, refreshToken: body.refresh_token, expiresInSec: body.expires_in });
  return { server, store, clock, manager, clientId, origin: server.origin, fetch };
}

function refreshPosts(server: FakeServer): number {
  return server.requests.filter((r) => r.path === '/oauth/token' && r.form.grant_type === 'refresh_token').length;
}

function sentRefreshTokens(server: FakeServer): string[] {
  return server.requests.filter((r) => r.form.grant_type === 'refresh_token').map((r) => r.form.refresh_token ?? '');
}

let r: Rig;

beforeEach(async () => {
  r = await rig();
});

describe('refresh single flight (P0-6)', () => {
  it('sends exactly one POST for five concurrent refreshes, and a later sequential one sends a second', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => r.manager.refresh(r.origin)));
    expect(refreshPosts(r.server)).toBe(1);
    expect(new Set(results.map((x) => (x.kind === 'ok' ? x.accessToken : x.kind))).size).toBe(1);
    await r.manager.refresh(r.origin);
    expect(refreshPosts(r.server)).toBe(2);
  });

  it('gives a failing flight to every caller, then retries on a later call once the backoff has passed', async () => {
    r.server.queue('/oauth/token', () => new Response('boom', { status: 500 }));
    const results = await Promise.all([r.manager.refresh(r.origin), r.manager.refresh(r.origin), r.manager.refresh(r.origin)]);
    expect(refreshPosts(r.server)).toBe(1);
    for (const x of results) expect(x).toMatchObject({ kind: 'retry', reason: 'server' });
    r.clock.advance(10 * 60_000);
    expect((await r.manager.refresh(r.origin)).kind).toBe('ok');
    expect(refreshPosts(r.server)).toBe(2);
  });

  it('does not let a hanging server hold the lock forever', async () => {
    const hung = await rig({ fetch: undefined });
    const slow = createTokenManager({ http: createHttp({ fetch: hung.server.fetch, defaultTimeoutMs: 20 }), store: hung.store, clock: hung.clock, getClientId: () => Promise.resolve(hung.clientId), random: () => 1 });
    hung.server.hang('/oauth/token');
    expect(await slow.refresh(hung.origin)).toMatchObject({ kind: 'retry', reason: 'timeout' });
    hung.clock.advance(10 * 60_000);
    expect((await slow.refresh(hung.origin)).kind).toBe('ok');
  });
});

describe('rotation and persistence order (P0-7)', () => {
  it('never sends the old refresh token after a successful rotation, and overwrites one key without removing it', async () => {
    const first = r.store.entries()[refreshTokenKey(r.origin)];
    await r.manager.refresh(r.origin);
    const second = r.store.entries()[refreshTokenKey(r.origin)];
    expect(second).not.toBe(first);
    await r.manager.refresh(r.origin);
    const sent = sentRefreshTokens(r.server);
    expect(sent).toEqual([first, second]);
    expect(sent).not.toContain(r.store.entries()[refreshTokenKey(r.origin)]);
    expect(r.store.log.filter((l) => l.startsWith('remove:'))).toEqual([]);
    expect(new Set(r.store.log.map((l) => l.split(':').slice(1).join(':'))).size).toBe(1);
  });

  it('keeps the old token and reports a retryable error when the write fails; the server still accepts the old one once', async () => {
    const old = r.store.entries()[refreshTokenKey(r.origin)];
    r.store.failSet(true);
    const result = await r.manager.refresh(r.origin);
    expect(result).toMatchObject({ kind: 'retry', reason: 'storage' });
    expect(r.store.entries()[refreshTokenKey(r.origin)]).toBe(old);
    expect(r.store.log.filter((l) => l.startsWith('remove:'))).toEqual([]);
    r.store.failSet(false);
    r.clock.advance(10 * 60_000);
    expect((await r.manager.refresh(r.origin)).kind).toBe('ok');
    expect(sentRefreshTokens(r.server)).toEqual([old, old]);
  });

  it('survives a crash after the response arrives: a fresh manager sends the old token again and the server accepts it', async () => {
    const old = r.store.entries()[refreshTokenKey(r.origin)];
    r.store.failSet(true);
    await r.manager.refresh(r.origin);
    r.store.failSet(false);
    const restarted = createTokenManager({ http: createHttp({ fetch: r.server.fetch }), store: r.store, clock: r.clock, getClientId: () => Promise.resolve(r.clientId), random: () => 1 });
    expect((await restarted.refresh(r.origin)).kind).toBe('ok');
    expect(sentRefreshTokens(r.server)[1]).toBe(old);
    expect(r.store.entries()[refreshTokenKey(r.origin)]).not.toBe(old);
  });

  it('with the previous-token grace exhausted, the second use of a stale token is refused (control for the fake)', async () => {
    const old = r.store.entries()[refreshTokenKey(r.origin)] ?? '';
    await r.manager.refresh(r.origin);
    await r.manager.refresh(r.origin);
    const res = await createHttp({ fetch: r.server.fetch }).request({
      url: `${r.origin}/oauth/token`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old, client_id: r.clientId }).toString(),
    });
    expect(res.status).toBe(400);
  });
});

describe('failure classification (P0-8)', () => {
  const body = (error: string) => JSON.stringify({ error, error_description: 'x' });
  it.each([
    [400, body('invalid_grant'), null, { kind: 'relogin' }],
    [400, body('invalid_client'), null, { kind: 'relogin' }],
    [400, body('unauthorized_client'), null, { kind: 'relogin' }],
    [401, body('invalid_client'), null, { kind: 'relogin' }],
    [401, '', null, { kind: 'relogin' }],
    [503, body('temporarily_unavailable'), 30_000, { kind: 'retry', reason: 'unavailable', retryAfterMs: 30_000 }],
    [503, '', null, { kind: 'retry', reason: 'unavailable' }],
    [500, '', null, { kind: 'retry', reason: 'server' }],
    [502, '<html>', null, { kind: 'retry', reason: 'server' }],
    [429, '', 60_000, { kind: 'retry', reason: 'rate_limited', retryAfterMs: 60_000 }],
    [426, '', null, { kind: 'retry', reason: 'upgrade_required' }],
    [400, '<html>not json</html>', null, { kind: 'retry', reason: 'malformed' }],
    [400, body('invalid_request'), null, { kind: 'retry', reason: 'malformed' }],
    [200, '<html>', null, { kind: 'retry', reason: 'malformed' }],
  ] as const)('status %i body %s retryAfter %s classifies as %j', (status, text, retryAfterMs, expected) => {
    expect(classifyTokenFailure(status, text, retryAfterMs)).toMatchObject(expected);
  });

  it('marks the origin as needing re-login on invalid_grant but keeps the stored token', async () => {
    r.server.revokeAllGrants();
    expect(await r.manager.refresh(r.origin)).toEqual({ kind: 'relogin' });
    expect(await r.manager.getState(r.origin)).toBe('relogin_required');
    expect(r.store.entries()[refreshTokenKey(r.origin)]).toBeDefined();
  });

  it.each([
    ['503 temporarily_unavailable', () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503, headers: { 'retry-after': '30' } })],
    ['500', () => new Response('', { status: 500 })],
    ['429', () => new Response('', { status: 429, headers: { 'retry-after': '5' } })],
    ['malformed 200', () => new Response('{"nope":true}', { status: 200 })],
  ])('stays signed in on %s', async (_name, respond) => {
    r.server.queue('/oauth/token', respond);
    const res = await r.manager.refresh(r.origin);
    expect(res.kind).toBe('retry');
    expect(await r.manager.getState(r.origin)).toBe('signed_in');
    expect(r.store.entries()[refreshTokenKey(r.origin)]).toBeDefined();
  });

  it('stays signed in on a network error and on a redirect', async () => {
    const failing = await rig({ fetch: undefined });
    const down = createTokenManager({
      http: createHttp({ fetch: () => Promise.reject(new TypeError('offline')) }),
      store: failing.store,
      clock: failing.clock,
      getClientId: () => Promise.resolve(failing.clientId),
      random: () => 1,
    });
    expect(await down.refresh(failing.origin)).toMatchObject({ kind: 'retry', reason: 'network' });
    expect(await down.getState(failing.origin)).toBe('signed_in');
    const redirected = createTokenManager({
      http: createHttp({ fetch: () => Promise.resolve(new Response('', { status: 302, headers: { location: 'https://evil.example.test' } })) }),
      store: failing.store,
      clock: failing.clock,
      getClientId: () => Promise.resolve(failing.clientId),
      random: () => 1,
    });
    expect(await redirected.refresh(failing.origin)).toMatchObject({ kind: 'retry' });
    expect(await redirected.getState(failing.origin)).toBe('signed_in');
  });

  it('backs off: no request inside the window, Retry-After honoured, and a request after it', async () => {
    r.server.queue('/oauth/token', () => new Response('', { status: 503, headers: { 'retry-after': '30' } }));
    const first = await r.manager.refresh(r.origin);
    expect(first).toMatchObject({ kind: 'retry', retryAfterMs: 30_000 });
    expect(refreshPosts(r.server)).toBe(1);
    r.clock.advance(10_000);
    expect(await r.manager.refresh(r.origin)).toMatchObject({ kind: 'retry', reason: 'backoff', retryAfterMs: 20_000 });
    expect(refreshPosts(r.server)).toBe(1);
    r.clock.advance(20_000);
    expect((await r.manager.refresh(r.origin)).kind).toBe('ok');
    expect(refreshPosts(r.server)).toBe(2);
  });

  it('lets an explicit user action bypass the backoff', async () => {
    r.server.queue('/oauth/token', () => new Response('', { status: 500 }));
    await r.manager.refresh(r.origin);
    expect((await r.manager.refresh(r.origin, { ignoreBackoff: true })).kind).toBe('ok');
  });

  it('refuses a returned scope other than native', async () => {
    r.server.queue('/oauth/token', () => new Response(JSON.stringify({ access_token: 'a', token_type: 'bearer', expires_in: 3600, refresh_token: 'r', scope: 'native admin' }), { status: 200 }));
    expect(await r.manager.refresh(r.origin)).toMatchObject({ kind: 'retry', reason: 'malformed' });
    expect(r.store.entries()[refreshTokenKey(r.origin)]).not.toBe('r');
  });

  it('reports signed_out without a request when no token is stored', async () => {
    const empty = createTokenManager({ http: createHttp({ fetch: r.server.fetch }), store: createMemorySecureStore(), clock: r.clock, getClientId: () => Promise.resolve(r.clientId), random: () => 1 });
    const before = r.server.requests.length;
    expect(await empty.refresh(r.origin)).toEqual({ kind: 'signed_out' });
    expect(r.server.requests.length).toBe(before);
  });
});

describe('backoffMs', () => {
  it('prefers Retry-After, otherwise grows exponentially with jitter and a cap', () => {
    expect(backoffMs(1, 30_000, () => 1)).toBe(30_000);
    expect(backoffMs(1, null, () => 1)).toBe(1_000);
    expect(backoffMs(3, null, () => 1)).toBe(4_000);
    expect(backoffMs(3, null, () => 0)).toBe(2_000);
    expect(backoffMs(30, null, () => 1)).toBe(300_000);
    expect(backoffMs(2, 0, () => 1)).toBe(2_000);
  });
});

describe('access token lifetime', () => {
  it('serves the in-memory token, and refreshes about a minute before it expires, by local time only', async () => {
    const a = await r.manager.getAccessToken(r.origin);
    expect(a).not.toBeNull();
    expect(refreshPosts(r.server)).toBe(0);
    r.clock.advance(3_600_000 - 61_000);
    expect(await r.manager.getAccessToken(r.origin)).toBe(a);
    r.clock.advance(2_000);
    const b = await r.manager.getAccessToken(r.origin);
    expect(b).not.toBe(a);
    expect(refreshPosts(r.server)).toBe(1);
  });

  it('holds the access token only in memory (positive control: the refresh token is in the store)', async () => {
    const access = await r.manager.getAccessToken(r.origin);
    expect(JSON.stringify(r.store.entries())).not.toContain(access ?? 'none');
    expect(r.store.entries()[refreshTokenKey(r.origin)]).toBeDefined();
  });

  it('adopt rejects with a storage error when the secure store cannot be written', async () => {
    const store = createMemorySecureStore();
    store.failSet(true);
    const m = createTokenManager({ http: createHttp({ fetch: r.server.fetch }), store, clock: r.clock, getClientId: () => Promise.resolve('c'), random: () => 1 });
    await expect(m.adopt(r.origin, { accessToken: 'a', refreshToken: 'r', expiresInSec: 3600 })).rejects.toMatchObject({ code: 'storage_failed' });
    expect(await m.getAccessToken(r.origin)).toBeNull();
  });
});

describe('per-server scoping (P0-10)', () => {
  it('never sends one server the other server token, and switching back finds the first again', async () => {
    const a = createFakeServer({ origin: 'https://a.example.test' });
    const b = createFakeServer({ origin: 'https://b.example.test' });
    const router: FetchLike = (url, init) => (url.startsWith(a.origin) ? a.fetch(url, init) : b.fetch(url, init));
    const store = createMemorySecureStore();
    const clock = createManualClock(1_000_000);
    const ra = await rig({ server: a, store, clock, fetch: router });
    const rb = await rig({ server: b, store, clock, fetch: router });
    const tokenA = store.entries()[refreshTokenKey(a.origin)];
    const tokenB = store.entries()[refreshTokenKey(b.origin)];
    expect(tokenA).toBeDefined();
    expect(tokenB).toBeDefined();
    expect(tokenA).not.toBe(tokenB);

    await rb.manager.refresh(b.origin);
    expect(sentRefreshTokens(b)).toEqual([tokenB]);
    expect(sentRefreshTokens(a)).toEqual([]);

    await ra.manager.refresh(a.origin);
    expect(sentRefreshTokens(a)).toEqual([tokenA]);
    expect(sentRefreshTokens(b)).not.toContain(tokenA);
  });

  it('drops the in-memory access token when the server switches', async () => {
    const before = await r.manager.getAccessToken(r.origin);
    expect(before).not.toBeNull();
    r.manager.useOrigin('https://other.example.test');
    expect(await r.manager.getAccessToken('https://other.example.test')).toBeNull();
    const after = await r.manager.getAccessToken(r.origin);
    expect(after).not.toBe(before);
    expect(refreshPosts(r.server)).toBe(1);
  });
});

describe('sign out (P1)', () => {
  it('wipes only this origin, revokes the grant at the token endpoint, and keeps the client id untouched', async () => {
    const other = refreshTokenKey('https://other.example.test');
    await r.store.set(other, 'other-origin-token');
    const token = r.store.entries()[refreshTokenKey(r.origin)];
    await r.manager.signOut(r.origin);
    expect(r.store.entries()[refreshTokenKey(r.origin)]).toBeUndefined();
    expect(r.store.entries()[other]).toBe('other-origin-token');
    const revoke = r.server.requests.find((x) => x.path === '/oauth/token' && !x.form.grant_type);
    expect(revoke?.form).toEqual({ token, token_type_hint: 'refresh_token', client_id: r.clientId });
    expect(revoke?.method).toBe('POST');
    expect(revoke?.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded/);
    expect(await r.manager.getState(r.origin)).toBe('signed_out');
    expect(await r.manager.getAccessToken(r.origin)).toBeNull();
    expect((await r.manager.refresh(r.origin)).kind).toBe('signed_out');
  });

  it('still wipes when the revoke request fails (best effort)', async () => {
    const down = await rig({ fetch: undefined });
    const m = createTokenManager({ http: createHttp({ fetch: () => Promise.reject(new TypeError('offline')) }), store: down.store, clock: down.clock, getClientId: () => Promise.resolve(down.clientId), random: () => 1 });
    await expect(m.signOut(down.origin)).resolves.toBeUndefined();
    expect(down.store.entries()[refreshTokenKey(down.origin)]).toBeUndefined();
  });

  it('a refresh that is in flight when the user signs out cannot store a token afterwards, and its new grant is revoked', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: FetchLike = async (url, init) => {
      if (typeof init.body === 'string' && init.body.includes('grant_type=refresh_token')) await gate;
      return r.server.fetch(url, init);
    };
    const m = createTokenManager({ http: createHttp({ fetch: gated }), store: r.store, clock: r.clock, getClientId: () => Promise.resolve(r.clientId), random: () => 1 });
    const inFlight = m.refresh(r.origin);
    await Promise.resolve();
    const signingOut = m.signOut(r.origin);
    release();
    const [result] = await Promise.all([inFlight, signingOut]);
    expect(result.kind).toBe('signed_out');
    expect(r.store.entries()[refreshTokenKey(r.origin)]).toBeUndefined();
    expect(await m.getAccessToken(r.origin)).toBeNull();
    const rotated = r.server.requests.filter((x) => x.path === '/oauth/token' && !x.form.grant_type);
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    const probe = await createHttp({ fetch: r.server.fetch }).request({
      url: `${r.origin}/oauth/token`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sentRefreshTokens(r.server)[0] ?? '', client_id: r.clientId }).toString(),
    });
    expect(probe.status).toBe(400);
  });
});

describe('session check (P0-8, 401 from /api/client/session)', () => {
  const unauthorized = () => new Response('{}', { status: 401 });

  it('returns the identity when the session answers (positive control)', async () => {
    const res = await r.manager.checkSession(r.origin);
    expect(res).toMatchObject({ kind: 'ok', session: { userId: 'user-1', role: 'inspector' } });
    expect(refreshPosts(r.server)).toBe(0);
  });

  it('recovers when one 401 is cured by a refresh', async () => {
    r.server.queue('/api/client/session', unauthorized);
    expect((await r.manager.checkSession(r.origin)).kind).toBe('ok');
    expect(refreshPosts(r.server)).toBe(1);
  });

  it('asks for re-login only when the session still answers 401 after a successful refresh, keeping the token', async () => {
    r.server.queue('/api/client/session', unauthorized);
    r.server.queue('/api/client/session', unauthorized);
    expect(await r.manager.checkSession(r.origin)).toEqual({ kind: 'relogin' });
    expect(await r.manager.getState(r.origin)).toBe('relogin_required');
    expect(r.store.entries()[refreshTokenKey(r.origin)]).toBeDefined();
  });

  it('stays signed in when the session endpoint is unreachable', async () => {
    const offline = createTokenManager({ http: createHttp({ fetch: () => Promise.reject(new TypeError('offline')) }), store: r.store, clock: r.clock, getClientId: () => Promise.resolve(r.clientId), random: () => 1 });
    await offline.adopt(r.origin, { accessToken: 'a', refreshToken: r.store.entries()[refreshTokenKey(r.origin)] ?? 'x', expiresInSec: 3600 });
    expect(await offline.checkSession(r.origin)).toMatchObject({ kind: 'retry', reason: 'network' });
    expect(await offline.getState(r.origin)).toBe('signed_in');
  });
});
