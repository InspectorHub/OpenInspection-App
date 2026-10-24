import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createHttp } from './http';
import { createLoginFlow } from './pkce-login';
import { createRegistrar } from './registration';
import { fetchCompat, loadClientId, refreshTokenKey } from './server-config';
import { createFakeServer, type FakeServer } from './test-support/fake-server';
import { createMemorySecureStore, type MemorySecureStore } from './test-support/memory-secure-store';
import { createTokenManager, type TokenManager } from './tokens';

interface World {
  server: FakeServer;
  db: Db;
  store: MemorySecureStore;
  tokens: TokenManager;
  flow: ReturnType<typeof createLoginFlow>;
  http: ReturnType<typeof createHttp>;
}

async function world(): Promise<World> {
  const server = createFakeServer();
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const store = createMemorySecureStore();
  const clock = createManualClock(9_000_000);
  const http = createHttp({ fetch: server.fetch, defaultHeaders: { 'X-Client-Platform': 'android', 'X-Client-Version': '0.1.0' } });
  const registrar = createRegistrar({ http, db });
  const tokens = createTokenManager({ http, store, clock, getClientId: (o) => loadClientId(db, o), random: () => 1 });
  const flow = createLoginFlow({ http, db, registrar, tokens, authSession: server.authSession, clock });
  return { server, db, store, tokens, flow, http };
}

async function seedLocalData(db: Db): Promise<void> {
  await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['inspection-1', new Uint8Array([1, 2, 3])]);
  await db.run('INSERT INTO resource_cache (key, etag, body, fetched_at) VALUES (?, ?, ?, ?)', ['k', 'e', '{}', 1]);
  await db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['m1', 'i1', 'photo', '/p', 'image/jpeg', '{}', 'pending', 1]);
  await db.run('INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['o1', 1, 'save', '{}', 'pending', 1]);
  await db.run('INSERT INTO work_package (inspection_id, refreshed_at) VALUES (?, ?)', ['i1', 1]);
}

async function rowCounts(db: Db): Promise<Record<string, number>> {
  const tables = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
    counts[name] = rows[0]?.n ?? -1;
  }
  return counts;
}

function allSecrets(w: World): string[] {
  const verifiers = w.server.requests.map((r) => r.form.code_verifier).filter((v): v is string => Boolean(v));
  const wire = w.server.secrets().filter((s) => !s.startsWith('client-'));
  return [...wire, ...verifiers];
}

describe('register, sign in, refresh, refresh failure, re-login', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    await seedLocalData(w.db);
  });

  it('runs the whole lifecycle and never touches local data on a refresh failure', async () => {
    const compat = await fetchCompat(w.http, w.server.origin, 'android');
    expect(compat.nativeLoginVerified).toBe(false);

    const login = await w.flow.signIn(w.server.origin);
    expect(login.session.role).toBe('inspector');
    expect(w.server.count('/oauth/register')).toBe(1);
    expect(await w.tokens.getState(w.server.origin)).toBe('signed_in');
    const afterLogin = await rowCounts(w.db);
    expect(afterLogin.ydoc_updates).toBe(1);
    expect(afterLogin.media).toBe(1);
    expect(afterLogin.outbox).toBe(1);

    const first = w.store.entries()[refreshTokenKey(w.server.origin)];
    expect((await w.tokens.refresh(w.server.origin)).kind).toBe('ok');
    const rotated = w.store.entries()[refreshTokenKey(w.server.origin)];
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(first);

    expect((await w.tokens.refresh(w.server.origin)).kind).toBe('ok');
    const sent = w.server.requests.filter((r) => r.form.grant_type === 'refresh_token').map((r) => r.form.refresh_token);
    expect(sent).toEqual([first, rotated]);
    expect(sent).not.toContain(w.store.entries()[refreshTokenKey(w.server.origin)]);

    w.server.queue('/oauth/token', () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Member is no longer active' }), { status: 400 }));
    expect(await w.tokens.refresh(w.server.origin)).toEqual({ kind: 'relogin' });
    expect(await w.tokens.getState(w.server.origin)).toBe('relogin_required');
    expect(await rowCounts(w.db)).toEqual(afterLogin);

    const again = await w.flow.signIn(w.server.origin);
    expect(again.session.userId).toBe(login.session.userId);
    expect(await w.tokens.getState(w.server.origin)).toBe('signed_in');
    expect(w.server.count('/oauth/register')).toBe(1);
    const final = await rowCounts(w.db);
    expect({ ...final, device_state: 0 }).toEqual({ ...afterLogin, device_state: 0 });
  });

  it('keeps every local table intact through sign-out too', async () => {
    await w.flow.signIn(w.server.origin);
    const before = await rowCounts(w.db);
    await w.tokens.signOut(w.server.origin);
    expect(await rowCounts(w.db)).toEqual(before);
    expect(w.store.entries()[refreshTokenKey(w.server.origin)]).toBeUndefined();
    expect(await w.tokens.getState(w.server.origin)).toBe('signed_out');
  });
});

describe('secrecy (P0-9)', () => {
  const channels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  let output: string[];

  beforeEach(() => {
    output = [];
    for (const channel of channels) {
      vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
        output.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the output capture would notice a leaked secret (positive control)', () => {
    console.log('leak: refresh_token=RT-LEAK');
    expect(output.join('\n')).toContain('RT-LEAK');
  });

  it('keeps tokens, codes and verifiers out of the console, the database and thrown errors', async () => {
    const w = await world();
    await seedLocalData(w.db);
    const thrown: string[] = [];
    await w.flow.signIn(w.server.origin);
    await w.tokens.refresh(w.server.origin);
    w.server.queue('/oauth/token', () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await w.tokens.refresh(w.server.origin);
    w.server.authorizeMode = 'deny';
    await w.flow.signIn(w.server.origin).catch((e: unknown) => thrown.push(String((e as Error).message) + String((e as Error).stack)));
    w.server.authorizeMode = 'approve';
    w.server.queue('/oauth/token', () => new Response('x', { status: 500 }));
    await w.flow.signIn(w.server.origin).catch((e: unknown) => thrown.push(String((e as Error).message) + String((e as Error).stack)));
    await w.tokens.signOut(w.server.origin);

    const secrets = allSecrets(w);
    expect(secrets.length).toBeGreaterThan(5);
    const dbDump = JSON.stringify(await Promise.all(['device_state', 'resource_cache', 'media', 'outbox', 'work_package'].map((t) => w.db.query(`SELECT * FROM ${t}`))));
    const everything = { console: output.join('\n'), db: dbDump, thrown: thrown.join('\n') };
    for (const [where, text] of Object.entries(everything)) {
      for (const secret of secrets) expect(text, `${where} leaks a secret`).not.toContain(secret);
    }
    expect(thrown.length).toBe(2);
  });

  it('keeps the access token out of the secure store and every refresh token inside it (control)', async () => {
    const w = await world();
    await w.flow.signIn(w.server.origin);
    await w.tokens.refresh(w.server.origin);
    const stored = JSON.stringify(w.store.entries());
    const accessTokens = w.server.secrets().filter((s) => s.startsWith('at-'));
    const refreshTokens = w.server.secrets().filter((s) => s.startsWith('rt-'));
    expect(accessTokens.length).toBeGreaterThan(0);
    for (const t of accessTokens) expect(stored).not.toContain(t);
    expect(stored).toContain(refreshTokens[refreshTokens.length - 1]);
  });
});
