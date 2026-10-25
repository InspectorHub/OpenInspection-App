import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { isAuthError } from './errors';
import { createManualClock } from '../platform/clock';
import { createHttp, type FetchLike } from './http';
import { refreshTokenKey } from './server-config';
import { createMemorySecureStore } from './test-support/memory-secure-store';
import { createTokenManager } from './tokens';

beforeEach(installStrictGlobals);
afterEach(restoreGlobals);

const ORIGIN = 'https://oi.example.test';

function manager(fetchLike: FetchLike) {
  return createTokenManager({
    http: createHttp({ fetch: fetchLike }),
    store: createMemorySecureStore({ [refreshTokenKey(ORIGIN)]: 'stored-refresh' }),
    clock: createManualClock(1_000_000),
    getClientId: () => Promise.resolve('client-1'),
    random: () => 1,
  });
}

const refused: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
const answer = (status: number, body: string): FetchLike => () => Promise.resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } }));

async function thrownCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return isAuthError(err) ? err.code : 'not_an_auth_error';
  }
}

describe('getAccessToken when the refresh never reached a verdict', () => {
  it('a server that cannot be reached is an error, not "no token": null means signed out or refused', async () => {
    expect(await thrownCode(manager(refused).getAccessToken(ORIGIN))).toBe('server_unreachable');
  });

  it.each([
    ['500', 500, '{}'],
    ['503', 503, '{}'],
    ['429', 429, '{}'],
    ['a malformed 200 body', 200, 'not json'],
  ])('%s is not a verdict either: it throws and the session stays signed in', async (_name, status, body) => {
    const m = manager(answer(status, body));
    expect(await thrownCode(m.getAccessToken(ORIGIN))).not.toBeNull();
    expect(await m.getState(ORIGIN)).toBe('signed_in');
  });

  it('a second ask during the back-off throws too (it never turns into null)', async () => {
    const m = manager(refused);
    await thrownCode(m.getAccessToken(ORIGIN));
    expect(await thrownCode(m.getAccessToken(ORIGIN))).not.toBeNull();
    expect(await m.getState(ORIGIN)).toBe('signed_in');
  });

  it('control: a definite refusal (400 invalid_grant) answers null and the session needs a new sign-in', async () => {
    const m = manager(answer(400, JSON.stringify({ error: 'invalid_grant' })));
    expect(await m.getAccessToken(ORIGIN)).toBeNull();
    expect(await m.getState(ORIGIN)).toBe('relogin_required');
  });

  it('control: no stored token answers null (signed out)', async () => {
    const m = createTokenManager({ http: createHttp({ fetch: refused }), store: createMemorySecureStore(), clock: createManualClock(1), getClientId: () => Promise.resolve('c'), random: () => 1 });
    expect(await m.getAccessToken(ORIGIN)).toBeNull();
  });

  it('control: a good refresh gives the token', async () => {
    const ok = answer(200, JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'bearer', expires_in: 3600 }));
    expect(await manager(ok).getAccessToken(ORIGIN)).toBe('fresh-access');
  });
});
