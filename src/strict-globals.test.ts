import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAndroidAuthSession, type AppLike, type BrowserLike } from './auth/auth-session';
import { createHttp } from './auth/http';
import { createTokenManager } from './auth/tokens';
import { createMemorySecureStore } from './auth/test-support/memory-secure-store';
import { realFetch } from './app/compose';
import { createManualClock } from './platform/clock';
import { createSqlJsDb } from './platform/db-sqljs';
import { randomHex32 } from './platform/db-capacitor';
import { installStrictGlobals, restoreGlobals } from './test-support/strict-globals';

beforeEach(installStrictGlobals);
afterEach(restoreGlobals);

describe('the strict global shim', () => {
  it('rejects a builtin called with another this, as a WebView does', () => {
    const detached = { setTimeout, clearTimeout };
    expect(() => detached.setTimeout(() => undefined, 1)).toThrow('Illegal invocation');
    expect(() => detached.clearTimeout(undefined)).toThrow('Illegal invocation');
    const holder = { fetch };
    expect(() => void holder.fetch('http://x.test/')).toThrow('Illegal invocation');
    const bare = crypto.getRandomValues;
    expect(() => bare(new Uint8Array(1))).toThrow('Illegal invocation');
  });

  it('allows a bare call, a call through globalThis and a method call on crypto', () => {
    const handle = setTimeout(() => undefined, 1);
    clearTimeout(handle);
    globalThis.clearTimeout(globalThis.setTimeout(() => undefined, 1));
    expect(crypto.getRandomValues(new Uint8Array(2))).toHaveLength(2);
  });
});

describe('default-timer and default-fetch paths under the strict globals', () => {
  it('token manager: adopt bounds its secure-store write with the default timers', async () => {
    const store = createMemorySecureStore();
    const http = createHttp({ fetch: realFetch });
    const manager = createTokenManager({ http, store, clock: createManualClock(1_000), getClientId: () => Promise.resolve('client') });
    await expect(manager.adopt('https://oi.example.test', { accessToken: 'a', refreshToken: 'r', expiresInSec: 3600 })).resolves.toBeUndefined();
    expect(store.log.some((entry) => entry.startsWith('set:'))).toBe(true);
  });

  it('http: a request through the real fetch wrapper completes with the default timer', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', function strictFetch(this: unknown, input: string): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      seen.push(input);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const http = createHttp({ fetch: realFetch });
    const res = await http.request({ url: 'https://oi.example.test/x', method: 'GET' });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['https://oi.example.test/x']);
  });

  it('auth session: start arms and cancel clears the default timers', async () => {
    const browser: BrowserLike = {
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    };
    const app: AppLike = { addListener: () => Promise.resolve({ remove: () => Promise.resolve() }) };
    const session = createAndroidAuthSession({ browser, app });
    const started = session.start('https://oi.example.test/oauth/authorize', 'io.inspectorhub.app');
    session.cancel();
    await expect(started).rejects.toMatchObject({ code: 'sign_in_cancelled' });
  });

  it('db: a call that waits behind a transaction arms and clears the default timers', async () => {
    const db = await createSqlJsDb();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = db.transaction(async () => {
      await gate;
    });
    const waiting = db.query('SELECT 1 AS one');
    release();
    await running;
    expect(await waiting).toEqual([{ one: 1 }]);
  });

  it('random bytes for the database secret come from a crypto method call', () => {
    expect(randomHex32()).toMatch(/^[0-9a-f]{64}$/);
  });
});
