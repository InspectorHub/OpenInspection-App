import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock, type ManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import type { AuthSession } from './auth-session';
import { createAndroidAuthSession } from './auth-session';
import { AuthError, isAuthError } from './errors';
import { createHttp, type FetchLike } from './http';
import { buildAuthorizeUrl, createLoginFlow, parseCallback, type LoginFlow } from './pkce-login';
import { createRegistrar } from './registration';
import { loadClientId, loadIdentity, refreshTokenKey, saveIdentity } from './server-config';
import { createFakeServer, s256, type FakeServer } from './test-support/fake-server';
import { createMemorySecureStore, type MemorySecureStore } from './test-support/memory-secure-store';
import { createTokenManager } from './tokens';

const CALLBACK = 'io.inspectorhub.app:/oauth/callback';

interface Rig {
  server: FakeServer;
  db: Db;
  store: MemorySecureStore;
  clock: ManualClock;
  flow: LoginFlow;
  started: string[];
}

async function rig(options: { server?: FakeServer; session?: (authUrl: string, server: FakeServer, clock: ManualClock) => Promise<string>; fetch?: FetchLike; cancelSession?: () => void; authSession?: AuthSession } = {}): Promise<Rig> {
  const server = options.server ?? createFakeServer();
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const store = createMemorySecureStore();
  const clock = createManualClock(5_000_000);
  const http = createHttp({ fetch: options.fetch ?? server.fetch });
  const registrar = createRegistrar({ http, db });
  const tokens = createTokenManager({ http, store, clock, getClientId: (origin) => loadClientId(db, origin), random: () => 1 });
  const started: string[] = [];
  const authSession: AuthSession = options.authSession ?? {
    start: (url) => {
      started.push(url);
      return options.session ? options.session(url, server, clock) : server.authSession.start(url, 'io.inspectorhub.app');
    },
    cancel: () => options.cancelSession?.(),
    onBrowserClosed: (listener) => server.authSession.onBrowserClosed(listener),
  };
  const flow = createLoginFlow({ http, db, registrar, tokens, authSession, clock });
  return { server, db, store, clock, flow, started };
}

/** A browser stand-in that approves the request, then lets `edit` rewrite the callback URL. */
function approveThen(edit: (callback: URL, authUrl: URL) => void): (authUrl: string, server: FakeServer) => Promise<string> {
  return async (authUrl, server) => {
    const callback = new URL(await server.authorize(authUrl));
    edit(callback, new URL(authUrl));
    return callback.toString();
  };
}

function tokenPosts(server: FakeServer, grantType: string): number {
  return server.requests.filter((r) => r.path === '/oauth/token' && r.form.grant_type === grantType).length;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAuthError(err)) return err.code;
    throw err;
  }
  return 'resolved';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('endpoint pinning (P0-1)', () => {
  it('only ever talks to the configured origin on the fixed paths', async () => {
    const r = await rig();
    await r.flow.signIn(r.server.origin);
    const urls = r.server.requests.map((x) => x.path);
    expect(new Set(urls)).toEqual(new Set(['/oauth/register', '/oauth/token', '/api/client/session']));
    expect(new URL(r.started[0] ?? '').origin).toBe(r.server.origin);
    expect(new URL(r.started[0] ?? '').pathname).toBe('/oauth/authorize');
  });

  it('fails when the token endpoint redirects to another host, and that host is never contacted (positive control: same origin works)', async () => {
    const hosts: string[] = [];
    const server = createFakeServer();
    const spying: FetchLike = (url, init) => {
      hosts.push(new URL(url).origin);
      return server.fetch(url, init);
    };
    const ok = await rig({ server, fetch: spying });
    await ok.flow.signIn(server.origin);
    expect(new Set(hosts)).toEqual(new Set([server.origin]));

    const evilServer = createFakeServer();
    const evilHosts: string[] = [];
    const redirecting: FetchLike = (url, init) => {
      evilHosts.push(new URL(url).origin);
      if (new URL(url).pathname === '/oauth/token') return Promise.resolve(new Response('', { status: 307, headers: { location: 'https://evil.example.test/token' } }));
      return evilServer.fetch(url, init);
    };
    const bad = await rig({ server: evilServer, fetch: redirecting });
    expect(await codeOf(bad.flow.signIn(evilServer.origin))).toBe('server_redirected');
    expect(evilHosts).not.toContain('https://evil.example.test');
  });
});

describe('PKCE hygiene (P0-4)', () => {
  it('builds the authorize URL with S256, scope=native exactly, and no verifier', async () => {
    const r = await rig();
    await r.flow.signIn(r.server.origin);
    const url = new URL(r.started[0] ?? '');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.getAll('scope')).toEqual(['native']);
    expect(p.get('redirect_uri')).toBe(CALLBACK);
    expect(p.get('client_id')).toBe(await loadClientId(r.db, r.server.origin));
    expect(p.get('code_verifier')).toBeNull();
    expect([...p.keys()].sort()).toEqual(['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'response_type', 'scope', 'state']);
    expect(p.get('state')?.length).toBeGreaterThanOrEqual(22);
  });

  it('sends a verifier of 43+ allowed characters whose S256 is the challenge, and uses fresh values every attempt', async () => {
    const r = await rig();
    await r.flow.signIn(r.server.origin);
    await r.flow.signIn(r.server.origin);
    const verifiers = r.server.requests.filter((x) => x.form.grant_type === 'authorization_code').map((x) => x.form.code_verifier ?? '');
    expect(verifiers).toHaveLength(2);
    for (const v of verifiers) expect(v).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(verifiers[0]).not.toBe(verifiers[1]);
    const urls = r.started.map((u) => new URL(u).searchParams);
    expect(urls[0]?.get('code_challenge')).toBe(await s256(verifiers[0] ?? ''));
    expect(urls[1]?.get('code_challenge')).toBe(await s256(verifiers[1] ?? ''));
    expect(urls[0]?.get('state')).not.toBe(urls[1]?.get('state'));
  });

  it('the fake token endpoint accepts the right verifier and rejects a wrong one (control for the check above)', async () => {
    const r = await rig({ session: approveThen(() => undefined) });
    await r.flow.signIn(r.server.origin);
    const clientId = (await loadClientId(r.db, r.server.origin)) ?? '';
    const callback = new URL(await r.server.authorize(`${r.server.origin}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, scope: 'native', code_challenge: await s256('a'.repeat(43)), code_challenge_method: 'S256', state: 's' }).toString()}`));
    const exchange = (verifier: string) =>
      createHttp({ fetch: r.server.fetch }).request({
        url: `${r.server.origin}/oauth/token`,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code') ?? '', redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier }).toString(),
      });
    expect((await exchange('b'.repeat(43))).status).toBe(400);
    expect((await exchange('a'.repeat(43))).status).toBe(200);
  });

  it('fails closed when SubtleCrypto is unavailable: no plain fallback, no browser opened', async () => {
    const r = await rig();
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: crypto.randomUUID.bind(crypto), subtle: undefined });
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('crypto_unavailable');
    expect(r.started).toEqual([]);
    expect(r.flow.hasPending()).toBe(false);
  });
});

describe('callback, state and iss (P0-5)', () => {
  it.each([
    ['state mismatch', approveThen((cb) => cb.searchParams.set('state', 'forged-state-value-0123456789'))],
    ['state missing', approveThen((cb) => cb.searchParams.delete('state'))],
    ['state repeated', approveThen((cb, auth) => cb.searchParams.append('state', auth.searchParams.get('state') ?? ''))],
    ['code missing', approveThen((cb) => cb.searchParams.delete('code'))],
    ['code repeated', approveThen((cb) => cb.searchParams.append('code', 'second'))],
    ['code empty', approveThen((cb) => cb.searchParams.set('code', ''))],
    ['wrong iss', approveThen((cb) => cb.searchParams.set('iss', 'https://evil.example.test'))],
    ['iss repeated', approveThen((cb) => {
      cb.searchParams.set('iss', 'https://oi.example.test');
      cb.searchParams.append('iss', 'https://oi.example.test');
    })],
  ])('rejects %s and never calls the token endpoint', async (_name, session) => {
    const r = await rig({ session });
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('callback_invalid');
    expect(tokenPosts(r.server, 'authorization_code')).toBe(0);
    expect(r.flow.hasPending()).toBe(false);
    expect(r.store.entries()).toEqual({});
  });

  it('accepts a matching iss and an absent iss (positive controls for the table above)', async () => {
    const withIss = await rig({ session: approveThen((cb) => cb.searchParams.set('iss', 'https://oi.example.test')) });
    await expect(withIss.flow.signIn(withIss.server.origin)).resolves.toBeDefined();
    const without = await rig();
    await expect(without.flow.signIn(without.server.origin)).resolves.toBeDefined();
    const slash = await rig({ session: approveThen((cb) => cb.searchParams.set('iss', 'https://oi.example.test/')) });
    await expect(slash.flow.signIn(slash.server.origin)).resolves.toBeDefined();
  });

  it('exchanges the code exactly once on a valid callback', async () => {
    const r = await rig();
    await r.flow.signIn(r.server.origin);
    expect(tokenPosts(r.server, 'authorization_code')).toBe(1);
  });

  it('aborts on error= without an exchange and shows only a fixed message, never error_description', async () => {
    const r = await rig({
      session: approveThen((cb) => {
        cb.searchParams.delete('code');
        cb.searchParams.set('error', 'access_denied');
        cb.searchParams.set('error_description', 'LEAKY-SERVER-TEXT');
      }),
    });
    const err = await r.flow.signIn(r.server.origin).then(
      () => new Error('sign-in should have failed'),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('sign_in_denied');
    expect(err.message).not.toContain('LEAKY');
    expect(tokenPosts(r.server, 'authorization_code')).toBe(0);
  });

  it('answers the consent cancel the engine really sends (error + state, no iss) as a denial', async () => {
    const r = await rig();
    r.server.authorizeMode = 'deny';
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('sign_in_denied');
  });

  it('ignores a callback silently when no login is pending: no network call, no state change', async () => {
    const r = await rig();
    const before = r.server.requests.length;
    const stray = `${CALLBACK}?code=abc&state=${'x'.repeat(30)}`;
    expect(await r.flow.handleCallback(stray)).toBeNull();
    expect(r.server.requests.length).toBe(before);
  });

  it('a replayed callback after a successful login is ignored without a network call', async () => {
    let seen = '';
    const r = await rig({
      session: async (authUrl, server) => {
        seen = await server.authorize(authUrl);
        return seen;
      },
    });
    await r.flow.signIn(r.server.origin);
    const before = r.server.requests.length;
    expect(await r.flow.handleCallback(seen)).toBeNull();
    expect(r.server.requests.length).toBe(before);
  });

  it('drops a pending login after its TTL: late callback is ignored (positive control: 9 minutes is fine)', async () => {
    const slow = await rig({
      session: async (authUrl, server, clock) => {
        const cb = await server.authorize(authUrl);
        clock.advance(11 * 60_000);
        return cb;
      },
    });
    expect(await codeOf(slow.flow.signIn(slow.server.origin))).toBe('sign_in_expired');
    expect(tokenPosts(slow.server, 'authorization_code')).toBe(0);
    const fine = await rig({
      session: async (authUrl, server, clock) => {
        const cb = await server.authorize(authUrl);
        clock.advance(9 * 60_000);
        return cb;
      },
    });
    await expect(fine.flow.signIn(fine.server.origin)).resolves.toBeDefined();
  });
});

describe('parseCallback and buildAuthorizeUrl', () => {
  it('matches only the exact scheme and path (positive control first)', () => {
    expect(parseCallback(`${CALLBACK}?code=c&state=s`)?.get('code')).toBe('c');
    for (const bad of [
      'io.inspectorhub.app://oauth/callback?code=c',
      'io.inspectorhub.app:/oauth/callback/extra?code=c',
      'io.inspectorhub.app:/oauth/callbackx?code=c',
      'io.inspectorhub.app:/oauth/other?code=c',
      'io.inspectorhub.app:/other?code=c',
      'evil.app:/oauth/callback?code=c',
      'IO.INSPECTORHUB.APP.evil:/oauth/callback?code=c',
      'https://oi.example.test/oauth/callback?code=c',
      'https://io.inspectorhub.app/oauth/callback?code=c',
      'not a url',
      '',
    ]) {
      expect(parseCallback(bad), bad).toBeNull();
    }
  });

  it('builds the URL from the origin, with every value encoded', () => {
    const url = new URL(buildAuthorizeUrl({ origin: 'https://oi.example.test', clientId: 'a b&c', challenge: 'ch', state: 's+t' }));
    expect(url.origin + url.pathname).toBe('https://oi.example.test/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('a b&c');
    expect(url.searchParams.get('state')).toBe('s+t');
    expect(url.search).toContain('scope=native');
  });
});

describe('dismissal and concurrency (P0-12, P1)', () => {
  it('rejects and clears the pending login when the browser is dismissed; a new attempt then works', async () => {
    const r = await rig();
    r.server.authorizeMode = 'dismiss';
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('sign_in_cancelled');
    expect(r.flow.hasPending()).toBe(false);
    expect(tokenPosts(r.server, 'authorization_code')).toBe(0);
    r.server.authorizeMode = 'approve';
    await expect(r.flow.signIn(r.server.origin)).resolves.toBeDefined();
  });

  it('returns the same promise for a second call while one login is pending', async () => {
    const r = await rig();
    const a = r.flow.signIn(r.server.origin);
    const b = r.flow.signIn(r.server.origin);
    expect(b).toBe(a);
    await a;
    expect(r.started).toHaveLength(1);
    expect(r.server.count('/oauth/register')).toBe(1);
  });
});

describe('one login at a time, cancel and expiry (review wave)', () => {
  it('rejects sign_in_in_progress for a different origin while one is running; the same origin shares the promise (positive control)', async () => {
    const r = await rig();
    const a = r.flow.signIn(r.server.origin);
    expect(await codeOf(r.flow.signIn('https://other.example.test'))).toBe('sign_in_in_progress');
    expect(r.flow.signIn(r.server.origin)).toBe(a);
    await expect(a).resolves.toBeDefined();
    expect(r.started).toHaveLength(1);
    await expect(r.flow.signIn(r.server.origin)).resolves.toBeDefined();
  });

  it('cancel() ends the waiting login as cancelled, clears the pending record, and a new login then works', async () => {
    let reject: (e: Error) => void = () => undefined;
    const r = await rig({
      session: () =>
        new Promise<string>((_resolve, rej) => {
          reject = rej;
        }),
      cancelSession: () => reject(new AuthError('sign_in_cancelled')),
    });
    const attempt = r.flow.signIn(r.server.origin);
    const outcome = codeOf(attempt);
    while (r.started.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(r.flow.hasPending()).toBe(true);
    r.flow.cancel();
    expect(await outcome).toBe('sign_in_cancelled');
    expect(r.flow.hasPending()).toBe(false);
    expect(tokenPosts(r.server, 'authorization_code')).toBe(0);
    r.server.authorizeMode = 'approve';
    const next = await rig({ server: r.server });
    await expect(next.flow.signIn(next.server.origin)).resolves.toBeDefined();
  });

  it('forwards the browser-closed hint without ending the login', async () => {
    const r = await rig();
    let hints = 0;
    r.flow.onBrowserClosed(() => {
      hints += 1;
    });
    await r.flow.signIn(r.server.origin);
    expect(hints).toBe(0);
  });

  describe('with the real Android session and fake timers', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a login whose callback never arrives expires, clears both pending records, and a later sign-in works', async () => {
      const opened: string[] = [];
      let closed = 0;
      const never = createAndroidAuthSession({
        browser: {
          open: ({ url }) => {
            opened.push(url);
            return Promise.resolve();
          },
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
          addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
        },
        app: { addListener: () => Promise.resolve({ remove: () => Promise.resolve() }) },
        timeoutMs: 60_000,
      });
      const r = await rig({ authSession: never });
      vi.useFakeTimers();
      const outcome = codeOf(r.flow.signIn(r.server.origin));
      for (let i = 0; i < 100 && opened.length === 0; i += 1) await vi.advanceTimersByTimeAsync(10);
      expect(opened).toHaveLength(1);
      expect(r.flow.hasPending()).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toBe('sign_in_expired');
      expect(r.flow.hasPending()).toBe(false);
      expect(closed).toBe(1);
      expect(tokenPosts(r.server, 'authorization_code')).toBe(0);
      vi.useRealTimers();
      const again = await rig({ server: r.server });
      await expect(again.flow.signIn(again.server.origin)).resolves.toBeDefined();
    });
  });
});

describe('a callback delivered through handleCallback while signIn waits', () => {
  it('settles the signIn exactly once with the success, never sign_in_expired afterwards', async () => {
    let seen = '';
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const r = await rig({
      session: async (authUrl, server) => {
        seen = await server.authorize(authUrl);
        await gate;
        return seen;
      },
    });
    const attempt = r.flow.signIn(r.server.origin);
    const outcome = codeOf(attempt);
    while (seen === '') await new Promise((resolve) => setTimeout(resolve, 1));
    const viaCallback = await r.flow.handleCallback(seen);
    expect(viaCallback?.origin).toBe(r.server.origin);
    open();
    expect(await outcome).toBe('resolved');
    expect(tokenPosts(r.server, 'authorization_code')).toBe(1);
    expect(r.flow.hasPending()).toBe(false);
  });
});

describe('scope exactness (P0-11)', () => {
  it('rejects a returned scope other than native, stores nothing, and revokes the grant it was just given', async () => {
    const r = await rig();
    r.server.queue('/oauth/token', () => new Response(JSON.stringify({ access_token: 'a1', token_type: 'bearer', expires_in: 3600, refresh_token: 'r-from-wide-grant', scope: 'native mcp' }), { status: 200 }));
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('scope_mismatch');
    expect(r.store.entries()).toEqual({});
    const revoke = r.server.requests.find((x) => x.path === '/oauth/token' && !x.form.grant_type);
    expect(revoke?.form.token).toBe('r-from-wide-grant');
  });
});

describe('registration retry (P1)', () => {
  const invalidClient = () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });

  it('re-registers once on invalid_client and signs in with the new client', async () => {
    const r = await rig();
    r.server.queue('/oauth/token', invalidClient);
    await r.flow.signIn(r.server.origin);
    expect(r.server.count('/oauth/register')).toBe(2);
    expect(r.started).toHaveLength(2);
    expect(r.store.entries()[refreshTokenKey(r.server.origin)]).toBeDefined();
  });

  it('gives up after one retry', async () => {
    const r = await rig();
    r.server.queue('/oauth/token', invalidClient);
    r.server.queue('/oauth/token', invalidClient);
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('registration_failed');
    expect(r.server.count('/oauth/register')).toBe(2);
    expect(r.store.entries()).toEqual({});
  });
});

describe('session check after login (P1)', () => {
  it('stores tokens and the identity for an allowed role', async () => {
    const r = await rig({ server: createFakeServer({ role: 'manager', userId: 'u9', tenantId: 't9' }) });
    const result = await r.flow.signIn(r.server.origin);
    expect(result.session).toMatchObject({ userId: 'u9', tenantId: 't9', role: 'manager' });
    expect(await loadIdentity(r.db)).toEqual({ userId: 'u9', tenantId: 't9', role: 'manager' });
    expect(r.store.entries()[refreshTokenKey(r.server.origin)]).toBeDefined();
  });

  it.each(['agent', 'client', 'viewer', ''])('rejects the role "%s", stores no token and revokes the grant', async (role) => {
    const r = await rig({ server: createFakeServer({ role }) });
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('session_role_not_allowed');
    expect(r.store.entries()).toEqual({});
    expect(await loadIdentity(r.db)).toBeNull();
    expect(r.server.requests.some((x) => x.path === '/oauth/token' && !x.form.grant_type)).toBe(true);
  });

  it.each(['owner', 'manager', 'inspector'])('accepts the role %s', async (role) => {
    const r = await rig({ server: createFakeServer({ role }) });
    await expect(r.flow.signIn(r.server.origin)).resolves.toBeDefined();
  });

  it('refuses a different user over existing local data and leaves the stored identity and tokens alone', async () => {
    const r = await rig({ server: createFakeServer({ userId: 'someone-else', tenantId: 't-other' }) });
    await saveIdentity(r.db, { userId: 'u1', tenantId: 't1', role: 'inspector' });
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('identity_mismatch');
    expect(await loadIdentity(r.db)).toEqual({ userId: 'u1', tenantId: 't1', role: 'inspector' });
    expect(r.store.entries()).toEqual({});
  });

  it('lets the same user and tenant sign in again over existing local data', async () => {
    const r = await rig();
    await saveIdentity(r.db, { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' });
    await expect(r.flow.signIn(r.server.origin)).resolves.toBeDefined();
  });

  it('rejects when the session endpoint answers 401 right after login', async () => {
    const r = await rig();
    r.server.queue('/api/client/session', () => new Response('{}', { status: 401 }));
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('sign_in_failed');
    expect(r.store.entries()).toEqual({});
  });
});

describe('native sign-in switched off', () => {
  it('reports it as unavailable at registration', async () => {
    const r = await rig({ server: createFakeServer({ nativeEnabled: false }) });
    expect(await codeOf(r.flow.signIn(r.server.origin))).toBe('native_login_unavailable');
    expect(r.started).toEqual([]);
  });
});

beforeEach(() => {
  vi.unstubAllGlobals();
});
