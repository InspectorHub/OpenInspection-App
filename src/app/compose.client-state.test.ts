import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../auth/http';
import { createMemoryKeyValue } from '../platform/kv';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { factsFor } from './client-state';
import { composeWith, realFetch, type AppServices } from './compose';
import { createSignedInWorld, createWorld, rowCounts, seedLocalData } from './test-support/world';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const COMPAT_OK = { success: true, data: { minSupported: null, recommended: '9.0.0', downloadUrl: 'https://downloads.example.test/app.apk', serverContractVersion: 0 } };

const facts = (services: AppServices, origin: string) => factsFor(services.clientState.store.get(), origin);

describe('services.clientState is fed by the http layer', () => {
  it('a 426 on any request marks that server as requiring an update, and the answer is still returned', async () => {
    const world = await createWorld({ fetch: () => Promise.resolve(json(426, { success: false })) });
    const res = await world.services.http.request({ url: `${world.server.origin}/api/inspections`, method: 'GET' });
    expect(res.status).toBe(426);
    expect(facts(world.services, world.server.origin)).toMatchObject({ upgrade: 'required' });
  });

  it('control: an ordinary answer leaves the state alone', async () => {
    const world = await createWorld({ fetch: () => Promise.resolve(json(200, {})) });
    await world.services.http.request({ url: `${world.server.origin}/api/inspections`, method: 'GET' });
    expect(world.services.clientState.store.get().origins.size).toBe(0);
  });

  it('a 426 on the token endpoint is not a sign-out: tokens, identity and every local row stay as they were', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = { rows: await rowCounts(world.db), stored: { ...world.store.entries() } };
    const refused: FetchLike = () => Promise.resolve(json(426, { error: 'upgrade_required' }));
    const services = composeWith({
      db: world.db,
      files: world.files,
      store: world.store,
      fetch: refused,
      authSession: world.server.authSession,
      clock: world.clock,
      platform: 'android',
      appVersion: '1.0.0',
    });
    services.tokens.useOrigin(world.server.origin);
    world.clock.advance(3_600_000);
    const check = await services.tokens.checkSession(world.server.origin);
    expect(check.kind).toBe('retry');
    expect(facts(services, world.server.origin)).toMatchObject({ upgrade: 'required' });
    expect(await rowCounts(world.db)).toEqual(before.rows);
    expect(world.store.entries()).toEqual(before.stored);
  });
});

describe('services.refreshCompat', () => {
  it('reads the compat answer into the state', async () => {
    const world = await createWorld({ fetch: () => Promise.resolve(json(200, COMPAT_OK)) });
    await world.services.refreshCompat(world.server.origin);
    expect(facts(world.services, world.server.origin)).toMatchObject({
      upgrade: 'recommended',
      serverTooOld: true,
      downloadUrl: 'https://downloads.example.test/app.apk',
    });
  });

  it('control: a sufficient server is not marked too old', async () => {
    const world = await createWorld({ fetch: () => Promise.resolve(json(200, { success: true, data: { ...COMPAT_OK.data, serverContractVersion: 2 } })) });
    await world.services.refreshCompat(world.server.origin);
    expect(facts(world.services, world.server.origin).serverTooOld).toBe(false);
  });

  it('an unreachable server never rejects and never invents "too old"', async () => {
    const world = await createWorld({ fetch: () => Promise.reject(new TypeError('network down')) });
    await expect(world.services.refreshCompat(world.server.origin)).resolves.toBeUndefined();
    expect(facts(world.services, world.server.origin)).toMatchObject({ serverTooOld: false, upgrade: 'none' });
    expect(world.services.clientState.store.get().refreshes).toBe(1);
  });

  it('an answer that is not a compat answer is the same as no answer', async () => {
    const world = await createWorld({ fetch: () => Promise.resolve(new Response('<html>captive portal</html>', { status: 200 })) });
    await expect(world.services.refreshCompat(world.server.origin)).resolves.toBeUndefined();
    expect(facts(world.services, world.server.origin)).toMatchObject({ serverTooOld: false, upgrade: 'none' });
  });

  it('a failed refresh keeps what an earlier one learned', async () => {
    let up = true;
    const world = await createWorld({ fetch: () => (up ? Promise.resolve(json(200, COMPAT_OK)) : Promise.reject(new TypeError('network down'))) });
    await world.services.refreshCompat(world.server.origin);
    up = false;
    await world.services.refreshCompat(world.server.origin);
    expect(facts(world.services, world.server.origin).serverTooOld).toBe(true);
  });

  it('two asks while one is in flight make one request', async () => {
    const world = await createWorld({ fetch: () => Promise.resolve(json(200, COMPAT_OK)) });
    await Promise.all([world.services.refreshCompat(world.server.origin), world.services.refreshCompat(world.server.origin)]);
    expect(world.fetched.filter((url) => url.includes('/api/client/compat'))).toHaveLength(1);
    await world.services.refreshCompat(world.server.origin);
    expect(world.fetched.filter((url) => url.includes('/api/client/compat'))).toHaveLength(2);
  });
});

describe('composition defaults', () => {
  it('uses the given key-value store for the dismissal and offers no external opener by default', async () => {
    const world = await createWorld();
    const kv = createMemoryKeyValue();
    const services = composeWith({ db: world.db, files: world.files, store: world.store, fetch: world.server.fetch, authSession: world.server.authSession, clock: world.clock, platform: 'ios', appVersion: '1.0.0', kv, builtAt: '2026-10-01T00:00:00.000Z' });
    expect(services.builtAt).toBe('2026-10-01T00:00:00.000Z');
    expect(services.platform).toBe('ios');
    await expect(services.openExternal('https://example.test')).rejects.toThrow();
  });
});

describe('refreshCompat on a WebView-strict page', () => {
  afterEach(() => restoreGlobals());

  it('calls fetch and the timers bare, as a WebView demands', async () => {
    const answer = vi.fn(() => Promise.resolve(json(200, COMPAT_OK)));
    vi.stubGlobal('fetch', answer);
    installStrictGlobals();
    const world = await createWorld();
    const services = composeWith({ db: world.db, files: world.files, store: world.store, fetch: realFetch, authSession: world.server.authSession, clock: world.clock, platform: 'android', appVersion: '1.0.0' });
    await services.refreshCompat(world.server.origin);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(facts(services, world.server.origin)).toMatchObject({ serverTooOld: true });
  });
});
