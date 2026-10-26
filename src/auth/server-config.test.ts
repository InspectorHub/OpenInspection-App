import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { isDeviceStateKey, migrate } from '../platform/schema';
import { isAuthError } from './errors';
import { createHttp, type FetchLike } from './http';
import {
  clearClientId,
  clientIdKey,
  fetchCompat,
  fetchSession,
  loadClientId,
  loadIdentity,
  parseServerUrl,
  refreshTokenKey,
  saveClientId,
  saveIdentity,
  serverEndpoints,
  writeDeviceState,
} from './server-config';
import { createFakeServer } from './test-support/fake-server';

function rejects(input: string, options?: { allowInsecureHttp?: boolean }): string {
  try {
    parseServerUrl(input, options);
  } catch (err) {
    if (isAuthError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

describe('parseServerUrl (P0-2)', () => {
  it.each([
    ['ftp://example.com', 'ftp'],
    ['http://example.com', 'plain http to a public host'],
    ['https://user:pw@example.com', 'userinfo'],
    ['https://a.com@b.com', 'userinfo trick'],
    ['https://a.com\\@b.com', 'backslash trick'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['', 'empty'],
    ['   ', 'blank'],
    ['example.com', 'no scheme'],
    ['https://192.168.1.5/admin', 'ip with path'],
    ['https://example.com/app', 'non-root path'],
    ['https://example.com?x=1', 'query'],
    ['https://example.com/?x=1', 'query with slash'],
    ['https://example.com?', 'empty query'],
    ['https://example.com#frag', 'fragment'],
    ['https://example.com/#', 'empty fragment'],
    ['https://', 'no host'],
    ['capacitor://localhost', 'capacitor scheme'],
    ['http://localhost.evil.com', 'loopback look-alike'],
  ])('rejects %s (%s)', (input) => {
    expect(rejects(input)).toBe('invalid_server_url');
  });

  it.each([
    ['https://oi.example.com', 'https://oi.example.com'],
    ['https://OI.Example.COM/', 'https://oi.example.com'],
    ['  https://oi.example.com:443  ', 'https://oi.example.com'],
    ['https://oi.example.com:8443', 'https://oi.example.com:8443'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
    ['http://localhost:8787/', 'http://localhost:8787'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
  ])('accepts %s and stores the canonical origin %s', (input, canonical) => {
    expect(parseServerUrl(input)).toBe(canonical);
  });

  it('allows plain http to another host only behind the explicit dev flag', () => {
    expect(rejects('http://10.0.2.2:8787')).toBe('invalid_server_url');
    expect(parseServerUrl('http://10.0.2.2:8787', { allowInsecureHttp: true })).toBe('http://10.0.2.2:8787');
    expect(rejects('https://user:pw@example.com', { allowInsecureHttp: true })).toBe('invalid_server_url');
  });
});

describe('per-origin keys and fixed endpoints (P0-1, P0-10)', () => {
  it('derives every endpoint from the configured origin and nothing else', () => {
    const e = serverEndpoints('https://oi.example.com');
    expect(e).toEqual({
      register: 'https://oi.example.com/oauth/register',
      authorize: 'https://oi.example.com/oauth/authorize',
      token: 'https://oi.example.com/oauth/token',
      compat: 'https://oi.example.com/api/client/compat',
      session: 'https://oi.example.com/api/client/session',
    });
    for (const url of Object.values(e)) expect(new URL(url).origin).toBe('https://oi.example.com');
  });

  it('keys the refresh token and the client id by origin', () => {
    expect(refreshTokenKey('https://a.example.com')).not.toBe(refreshTokenKey('https://b.example.com'));
    expect(refreshTokenKey('https://a.example.com')).toBe(refreshTokenKey('https://a.example.com'));
    expect(clientIdKey('https://a.example.com')).not.toBe(clientIdKey('https://b.example.com'));
  });
});

describe('fetchCompat (P1 compat hardening)', () => {
  const http = (server = createFakeServer()) => ({ server, http: createHttp({ fetch: server.fetch, defaultHeaders: { 'X-Client-Platform': 'android', 'X-Client-Version': '0.1.0' } }) });

  it('reads the policy, sends the platform, and does not claim native login works', async () => {
    const { server, http: h } = http();
    const info = await fetchCompat(h, server.origin, 'android');
    expect(info.serverContractVersion).toBe(1);
    expect(info.serverTooOld).toBe(false);
    expect(info.nativeLoginVerified).toBe(false);
    const req = server.requests[0];
    expect(req?.path).toBe('/api/client/compat');
    expect(req?.query.get('platform')).toBe('android');
    expect(req?.headers['x-client-version']).toBe('0.1.0');
  });

  it('compat 200 while native login is switched off still succeeds, and register then fails (compat is not proof)', async () => {
    const server = createFakeServer({ nativeEnabled: false });
    const h = createHttp({ fetch: server.fetch });
    const info = await fetchCompat(h, server.origin, 'android');
    expect(info.nativeLoginVerified).toBe(false);
    const register = await h.request({ url: serverEndpoints(server.origin).register, method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(register.status).toBe(404);
  });

  it('flags a low contract version as server-too-old without throwing', async () => {
    const server = createFakeServer({ contractVersion: 0 });
    const info = await fetchCompat(createHttp({ fetch: server.fetch }), server.origin, 'android');
    expect(info.serverTooOld).toBe(true);
  });

  it('keeps downloadUrl only when it is https', async () => {
    const respond = (downloadUrl: string | null): FetchLike => () =>
      Promise.resolve(new Response(JSON.stringify({ success: true, data: { minSupported: '1.0.0', recommended: null, downloadUrl, serverContractVersion: 1 } }), { status: 200 }));
    const https = await fetchCompat(createHttp({ fetch: respond('https://example.com/app.apk') }), 'https://oi.example.com', 'android');
    expect(https.downloadUrl).toBe('https://example.com/app.apk');
    for (const bad of ['http://example.com/app.apk', 'javascript:alert(1)', 'intent://x#Intent;end', 'https://user:pw@example.com/app.apk']) {
      const info = await fetchCompat(createHttp({ fetch: respond(bad) }), 'https://oi.example.com', 'android');
      expect(info.downloadUrl).toBeNull();
    }
  });

  it.each([
    ['not json', '<html>'],
    ['wrong shape', JSON.stringify({ success: true, data: { serverContractVersion: 'one' } })],
    ['missing data', JSON.stringify({ success: true })],
    ['success false', JSON.stringify({ success: false, data: { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 1 } })],
  ])('rejects a malformed body: %s', async (_name, body) => {
    const fetch: FetchLike = () => Promise.resolve(new Response(body, { status: 200 }));
    await expect(fetchCompat(createHttp({ fetch }), 'https://oi.example.com', 'android')).rejects.toMatchObject({ code: 'server_response_invalid' });
  });

  it('rejects a non-200, an oversize body and a redirect', async () => {
    const status500: FetchLike = () => Promise.resolve(new Response('{}', { status: 500 }));
    await expect(fetchCompat(createHttp({ fetch: status500 }), 'https://oi.example.com', 'android')).rejects.toMatchObject({ code: 'server_response_invalid' });
    const huge: FetchLike = () => Promise.resolve(new Response('x'.repeat(200_000), { status: 200 }));
    await expect(fetchCompat(createHttp({ fetch: huge }), 'https://oi.example.com', 'android')).rejects.toMatchObject({ code: 'server_response_invalid' });
    const redirect: FetchLike = () => Promise.resolve(new Response('', { status: 302, headers: { location: 'https://evil.example.test' } }));
    await expect(fetchCompat(createHttp({ fetch: redirect }), 'https://oi.example.com', 'android')).rejects.toMatchObject({ code: 'server_redirected' });
  });

  it('times out a hanging server (about 10 seconds by default; shortened here)', async () => {
    const server = createFakeServer();
    server.hang('/api/client/compat');
    await expect(fetchCompat(createHttp({ fetch: server.fetch }), server.origin, 'android', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'server_timeout' });
  });
});

describe('fetchSession', () => {
  it('returns the identity for a valid token and unauthorized for a 401 (positive control)', async () => {
    const fetch = vi.fn<FetchLike>();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { userId: 'u', tenantId: 't', role: 'owner', offlineMaxDays: 30 } }), { status: 200 }));
    fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const http = createHttp({ fetch });
    expect(await fetchSession(http, 'https://oi.example.com', 'tok')).toEqual({ kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'owner', offlineMaxDays: 30 }, serverDateMs: null, serverNowMs: null });
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get('authorization')).toBe('Bearer tok');
    expect(await fetchSession(http, 'https://oi.example.com', 'tok')).toEqual({ kind: 'unauthorized' });
  });

  it('carries the Date header of the same response, and null when it does not parse', async () => {
    const body = JSON.stringify({ success: true, data: { userId: 'u', tenantId: 't', role: 'owner', offlineMaxDays: 30 } });
    const dated: FetchLike = () => Promise.resolve(new Response(body, { status: 200, headers: { date: 'Wed, 21 Oct 2026 07:28:00 GMT' } }));
    expect(await fetchSession(createHttp({ fetch: dated }), 'https://oi.example.com', 'tok')).toMatchObject({ kind: 'ok', serverDateMs: Date.UTC(2026, 9, 21, 7, 28, 0) });
    const garbled: FetchLike = () => Promise.resolve(new Response(body, { status: 200, headers: { date: 'soon' } }));
    expect(await fetchSession(createHttp({ fetch: garbled }), 'https://oi.example.com', 'tok')).toMatchObject({ kind: 'ok', serverDateMs: null });
  });

  describe('the optional serverNowMs field of the body', () => {
    const answer = (extra: Record<string, unknown>, headers: Record<string, string> = {}): FetchLike => () =>
      Promise.resolve(new Response(JSON.stringify({ success: true, data: { userId: 'u', tenantId: 't', role: 'owner', offlineMaxDays: 30, ...extra } }), { status: 200, headers }));
    const read = (fetch: FetchLike) => fetchSession(createHttp({ fetch }), 'https://oi.example.com', 'tok');

    it('is carried as epoch milliseconds when it is an integer in the plausible range', async () => {
      expect(await read(answer({ serverNowMs: 1_800_000_000_000 }))).toMatchObject({ kind: 'ok', serverNowMs: 1_800_000_000_000, serverDateMs: null });
    });

    it('accepts both ends of the range and nothing outside it', async () => {
      expect(await read(answer({ serverNowMs: 1e12 }))).toMatchObject({ serverNowMs: 1e12 });
      expect(await read(answer({ serverNowMs: 1e14 }))).toMatchObject({ serverNowMs: 1e14 });
      expect(await read(answer({ serverNowMs: 1e12 - 1 }))).toMatchObject({ serverNowMs: null });
      expect(await read(answer({ serverNowMs: 1e14 + 1 }))).toMatchObject({ serverNowMs: null });
    });

    it.each([
      ['a float', 1_800_000_000_000.5],
      ['a numeric string', '1800000000000'],
      ['seconds instead of milliseconds', 1_800_000_000],
      ['zero', 0],
      ['negative', -1_800_000_000_000],
      ['null', null],
      ['an object', { ms: 1 }],
      ['a boolean', true],
    ])('treats %s as absent and still returns the session', async (_label, value) => {
      expect(await read(answer({ serverNowMs: value }))).toMatchObject({ kind: 'ok', session: { userId: 'u' }, serverNowMs: null });
    });

    it('is absent against a server that does not send it, next to a Date header', async () => {
      const result = await read(answer({}, { date: 'Wed, 21 Oct 2026 07:28:00 GMT' }));
      expect(result).toMatchObject({ serverNowMs: null, serverDateMs: Date.UTC(2026, 9, 21, 7, 28, 0) });
    });
  });

  it('rejects a body that is not a session', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response(JSON.stringify({ success: true, data: { userId: 1 } }), { status: 200 }));
    await expect(fetchSession(createHttp({ fetch }), 'https://oi.example.com', 'tok')).rejects.toMatchObject({ code: 'server_response_invalid' });
  });
});

describe('device_state helpers', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createSqlJsDb();
    await migrate(db, 0);
  });

  it('stores one client id per origin and clears only the requested one', async () => {
    await saveClientId(db, 'https://a.example.com', 'client-a');
    await saveClientId(db, 'https://b.example.com', 'client-b');
    expect(await loadClientId(db, 'https://a.example.com')).toBe('client-a');
    expect(await loadClientId(db, 'https://b.example.com')).toBe('client-b');
    await clearClientId(db, 'https://a.example.com');
    expect(await loadClientId(db, 'https://a.example.com')).toBeNull();
    expect(await loadClientId(db, 'https://b.example.com')).toBe('client-b');
  });

  it('every key the auth layer writes is a declared device_state key (positive control: the rows exist)', async () => {
    await saveClientId(db, 'https://a.example.com', 'client-a');
    await saveIdentity(db, { userId: 'u1', tenantId: 't1', role: 'manager' });
    const keys = (await db.query<{ key: string }>('SELECT key FROM device_state')).map((r) => r.key);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const key of keys) expect(isDeviceStateKey(key), key).toBe(true);
  });

  it('writeDeviceState refuses an undeclared key and writes nothing', async () => {
    await expect(writeDeviceState(db, 'not_a_declared_key', 'x')).rejects.toThrow(/device_state key/i);
    expect(await db.query('SELECT key FROM device_state')).toEqual([]);
    await writeDeviceState(db, 'role', 'owner');
    expect(await db.query('SELECT key, value FROM device_state')).toEqual([{ key: 'role', value: 'owner' }]);
  });

  it('round-trips the signed-in identity and reports none when absent', async () => {
    expect(await loadIdentity(db)).toBeNull();
    await saveIdentity(db, { userId: 'u1', tenantId: 't1', role: 'manager' });
    expect(await loadIdentity(db)).toEqual({ userId: 'u1', tenantId: 't1', role: 'manager' });
    await saveIdentity(db, { userId: 'u2', tenantId: 't2', role: 'owner' });
    expect(await loadIdentity(db)).toEqual({ userId: 'u2', tenantId: 't2', role: 'owner' });
  });
});
