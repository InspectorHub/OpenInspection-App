import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createHttp, type FetchLike } from './http';
import { createRegistrar } from './registration';
import { loadClientId } from './server-config';
import { createFakeServer } from './test-support/fake-server';

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

function setup(options?: Parameters<typeof createFakeServer>[0]) {
  const server = createFakeServer(options);
  const registrar = createRegistrar({ http: createHttp({ fetch: server.fetch }), db });
  return { server, registrar };
}

describe('client registration (RFC 7591)', () => {
  it('registers once per origin with the public-client metadata, then reuses the stored id', async () => {
    const { server, registrar } = setup();
    const first = await registrar.ensureClientId(server.origin);
    const second = await registrar.ensureClientId(server.origin);
    expect(second).toBe(first);
    expect(server.count('/oauth/register')).toBe(1);
    expect(await loadClientId(db, server.origin)).toBe(first);
    expect(server.requests[0]?.json).toEqual({
      client_name: 'InspectorHub',
      redirect_uris: ['io.inspectorhub.app:/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('registers separately for each origin (P0-10)', async () => {
    const a = setup({ origin: 'https://a.example.test' });
    const idA = await a.registrar.ensureClientId(a.server.origin);
    const b = createFakeServer({ origin: 'https://b.example.test' });
    const registrarB = createRegistrar({ http: createHttp({ fetch: b.fetch }), db });
    const idB = await registrarB.ensureClientId(b.origin);
    expect(idB).not.toBe(idA);
    expect(await loadClientId(db, a.server.origin)).toBe(idA);
    expect(await loadClientId(db, b.origin)).toBe(idB);
  });

  it('shares one request between concurrent callers', async () => {
    const { server, registrar } = setup();
    const ids = await Promise.all([registrar.ensureClientId(server.origin), registrar.ensureClientId(server.origin), registrar.ensureClientId(server.origin)]);
    expect(new Set(ids).size).toBe(1);
    expect(server.count('/oauth/register')).toBe(1);
  });

  it('ignores a client_secret in the response and stores it nowhere (positive control: the server did issue one)', async () => {
    const { server, registrar } = setup({ issueClientSecret: true });
    await registrar.ensureClientId(server.origin);
    const secret = server.secrets().find((s) => s.startsWith('secret-'));
    expect(secret).toBeDefined();
    const dump = JSON.stringify(await db.query('SELECT key, value FROM device_state'));
    expect(dump).not.toContain(secret);
  });

  it('forget() drops the stored id so the next call registers again', async () => {
    const { server, registrar } = setup();
    const first = await registrar.ensureClientId(server.origin);
    await registrar.forget(server.origin);
    expect(await loadClientId(db, server.origin)).toBeNull();
    const second = await registrar.ensureClientId(server.origin);
    expect(second).not.toBe(first);
    expect(server.count('/oauth/register')).toBe(2);
  });

  it.each([
    ['missing client_id', { redirect_uris: ['io.inspectorhub.app:/oauth/callback'] }],
    ['empty client_id', { client_id: '', redirect_uris: ['io.inspectorhub.app:/oauth/callback'] }],
    ['non-string client_id', { client_id: 7, redirect_uris: ['io.inspectorhub.app:/oauth/callback'] }],
    ['client_id with whitespace', { client_id: 'a b', redirect_uris: ['io.inspectorhub.app:/oauth/callback'] }],
    ['client_id too long', { client_id: 'a'.repeat(300), redirect_uris: ['io.inspectorhub.app:/oauth/callback'] }],
    ['different redirect_uris', { client_id: 'c', redirect_uris: ['https://evil.example.test/cb'] }],
    ['confidential auth method', { client_id: 'c', redirect_uris: ['io.inspectorhub.app:/oauth/callback'], token_endpoint_auth_method: 'client_secret_basic' }],
  ])('rejects a response with %s and stores nothing', async (_name, body) => {
    const fetch: FetchLike = () => Promise.resolve(new Response(JSON.stringify(body), { status: 201 }));
    const registrar = createRegistrar({ http: createHttp({ fetch }), db });
    await expect(registrar.ensureClientId('https://oi.example.test')).rejects.toMatchObject({ code: 'registration_failed' });
    expect(await loadClientId(db, 'https://oi.example.test')).toBeNull();
  });

  it('accepts a minimal valid response (positive control for the table above)', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response(JSON.stringify({ client_id: 'c-1', redirect_uris: ['io.inspectorhub.app:/oauth/callback'], token_endpoint_auth_method: 'none' }), { status: 201 }));
    const registrar = createRegistrar({ http: createHttp({ fetch }), db });
    expect(await registrar.ensureClientId('https://oi.example.test')).toBe('c-1');
  });

  it('reports native sign-in as unavailable when registration is refused (switch off)', async () => {
    const { server, registrar } = setup({ nativeEnabled: false });
    await expect(registrar.ensureClientId(server.origin)).rejects.toMatchObject({ code: 'native_login_unavailable' });
  });

  it('never surfaces the server error text', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response(JSON.stringify({ error: 'invalid_client_metadata', error_description: 'LEAKY-SERVER-TEXT' }), { status: 400 }));
    const registrar = createRegistrar({ http: createHttp({ fetch }), db });
    const err = await registrar.ensureClientId('https://oi.example.test').then(
      () => new Error('registration should have failed'),
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toContain('LEAKY');
    expect(err).toMatchObject({ code: 'registration_failed' });
  });
});
