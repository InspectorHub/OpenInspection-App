import * as Y from 'yjs';
import { vi } from 'vitest';
import type { Http, HttpRequest, HttpResponse } from '../../auth/http';
import type { SessionCheck } from '../../auth/tokens';
import { recordServerStateVector } from '../../collab/sync-proof';
import { createManualClock, type ManualClock } from '../../platform/clock';
import type { Db } from '../../platform/db';
import { createSqlJsDb } from '../../platform/db-sqljs';
import { migrate } from '../../platform/schema';
import type { Account } from '../outbox';
import { decideReconcile, type ReconcileDeps, type ReconcileResult } from '../reconcile-decision';
import { createSessionProbe, createVisibleClient } from '../visible-client';

export const ORIGIN = 'https://oi.example.test';
export const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
export const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };
export const TOKEN = 'access-token-secret';

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }): HttpResponse {
  const text = JSON.stringify(body);
  return { status, headers: new Headers(headers), text, json: body, retryAfterMs: null, upgrade: null, serverDateMs: null };
}

export const visibleReply = (visible: string[]): HttpResponse => jsonReply(200, { success: true, data: { visible } });

export type Scripted = HttpResponse | Error | ((ids: string[], n: number) => HttpResponse | Error);

export interface ReconcileWorld {
  db: Db;
  clock: ManualClock;
  state: {
    locked: boolean;
    lockedThrows: boolean;
    account: Account | null;
    /** The identity the server reports on /api/client/session. */
    sessionIdentity: Account;
    sessionStatus: number;
    /** Thrown by the identity request instead of an answer. */
    sessionError: Error | null;
    token: string | null;
  };
  server: {
    /** Ids the server shows; null means it shows everything it is asked about. */
    shows: Set<string> | null;
    /** Ids the server never shows, whatever else it shows. */
    hidden: Set<string>;
    script: Scripted[];
    /** Runs while a visible request is in flight, before it is answered. */
    hook: ((ids: string[], n: number) => void | Promise<void>) | null;
  };
  visibleRequests: string[][];
  sessionRequests: number;
  allRequests: HttpRequest[];
  checkSession: ReturnType<typeof vi.fn>;
  decide(overrides?: Partial<ReconcileDeps>): Promise<ReconcileResult>;
  pkg(id: string, o?: PackageOptions): Promise<void>;
  outbox(id: string | null, state?: string, o?: { op?: string; account?: Account }): Promise<void>;
  media(id: string, state: string): Promise<void>;
  ydoc(id: string): Promise<Uint8Array[]>;
  /** Records a server state vector that covers exactly the given rows. */
  cover(id: string, rows: Uint8Array[]): Promise<void>;
  hash(): Promise<string>;
}

export interface PackageOptions {
  account?: Account | null;
  confirmed?: number;
  pinned?: number;
  purging?: number;
  quarantine?: string | null;
}

/** Every table that holds inspection data. The lease row is excluded: a run takes it and gives it back. */
const DATA_TABLES = ['work_package', 'outbox', 'media', 'ydoc_updates', 'ydoc_sync', 'resource_cache', 'device_state'];

export async function createReconcileWorld(): Promise<ReconcileWorld> {
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const clock = createManualClock(1_000_000);
  const checkSession = vi.fn(() => Promise.resolve<SessionCheck>({ kind: 'ok', session: { userId: 'alice', tenantId: 'tenant-1', role: 'inspector', offlineMaxDays: 7 } }));
  const world = { checkSession } as unknown as ReconcileWorld;
  const visibleRequests: string[][] = [];
  const allRequests: HttpRequest[] = [];
  Object.assign(world, {
    db,
    clock,
    state: { locked: false, lockedThrows: false, account: ALICE, sessionIdentity: ALICE, sessionStatus: 200, sessionError: null, token: TOKEN },
    server: { shows: null, hidden: new Set<string>(), script: [], hook: null },
    visibleRequests,
    allRequests,
    sessionRequests: 0,
  });

  const http: Http = {
    request: async (req) => {
      allRequests.push(req);
      if (req.url === `${ORIGIN}/api/client/session`) {
        world.sessionRequests += 1;
        if (world.state.sessionError) throw world.state.sessionError;
        if (world.state.sessionStatus !== 200) return jsonReply(world.state.sessionStatus, { success: false });
        const { tenantId, userId } = world.state.sessionIdentity;
        return jsonReply(200, { success: true, data: { userId, tenantId, role: 'inspector', offlineMaxDays: 7 } });
      }
      const ids = (JSON.parse(req.body ?? '{}') as { ids: string[] }).ids;
      visibleRequests.push(ids);
      if (world.server.hook) await world.server.hook(ids, visibleRequests.length);
      const next = world.server.script.shift();
      const answer = typeof next === 'function' ? next(ids, visibleRequests.length) : next;
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer;
      const shows = world.server.shows;
      return visibleReply(ids.filter((id) => !world.server.hidden.has(id) && (shows === null || shows.has(id))));
    },
  };
  const tokens = {
    getAccessToken: () => Promise.resolve(world.state.token),
    checkSession: world.checkSession as unknown as () => Promise<SessionCheck>,
  };
  const visible = createVisibleClient({ http, tokens, origin: ORIGIN, clientHeaders: { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' } });
  const session = createSessionProbe({ http, tokens, origin: ORIGIN });
  let leaseTokens = 0;

  const baseDeps = (): ReconcileDeps => ({
    db,
    clock,
    account: () => world.state.account,
    isLocked: () => {
      if (world.state.lockedThrows) throw new Error('lock state unreadable');
      return world.state.locked;
    },
    visible,
    session,
    newToken: () => `reconcile-holder-${String((leaseTokens += 1))}`,
  });

  let n = 0;
  Object.assign(world, {
    decide: (overrides: Partial<ReconcileDeps> = {}) => decideReconcile({ ...baseDeps(), ...overrides }),
    pkg: async (id: string, o: PackageOptions = {}) => {
      const account = o.account === undefined ? ALICE : o.account;
      await db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id, purging, quarantine_source) VALUES (?, 1, ?, ?, ?, ?, ?, ?)', [
        id,
        o.pinned ?? 0,
        o.confirmed ?? 1,
        account?.tenantId ?? null,
        account?.userId ?? null,
        o.purging ?? 0,
        o.quarantine ?? null,
      ]);
    },
    outbox: async (id: string | null, state = 'pending', o: { op?: string; account?: Account } = {}) => {
      n += 1;
      const account = o.account ?? ALICE;
      await db.run(
        "INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, registry_version, tenant_id, user_id) VALUES (?, ?, ?, '{}', ?, 1, ?, 1, ?, ?)",
        [`key-${String(n)}`, n, o.op ?? 'inspection.update', state, id, account.tenantId, account.userId],
      );
    },
    media: async (id: string, state: string) => {
      n += 1;
      await db.run("INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, 'photo', 'media/x.jpg', 'image/jpeg', '{}', ?, 1)", [`pending-${String(n)}`, id, state]);
    },
    ydoc: async (id: string) => {
      const doc = new Y.Doc();
      const rows: Uint8Array[] = [];
      doc.on('update', (u: Uint8Array) => rows.push(u));
      doc.getMap<unknown>('m').set('k', id);
      for (const data of rows) await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [`results-${id}`, data]);
      return rows;
    },
    cover: async (id: string, rows: Uint8Array[]) => {
      const server = new Y.Doc();
      for (const row of rows) Y.applyUpdate(server, row);
      await recordServerStateVector(db, `results-${id}`, Y.encodeStateVector(server), 1);
    },
    hash: async () => {
      const parts: string[] = [];
      for (const table of DATA_TABLES) {
        const rows = await db.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
        parts.push(`${table}:${JSON.stringify(rows, (_k, v: unknown) => (v instanceof Uint8Array ? `bytes:${Array.from(v).join(',')}` : v))}`);
      }
      return parts.join('|');
    },
  });
  return world;
}

/** Packages p1..pN, all the signed-in account's and server-confirmed. */
export async function seedPackages(world: ReconcileWorld, count: number, prefix = 'p'): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(3, '0')}`);
  for (const id of ids) await world.pkg(id);
  return ids;
}
