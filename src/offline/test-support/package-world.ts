import type { Http, HttpRequest, HttpResponse } from '../../auth/http';
import type { SessionCheck } from '../../auth/tokens';
import { accountKey, type Account } from '../outbox';
import { createWorkPackageRefresher, type RefresherDeps, type RefreshReason, type RefreshSummary, type WorkPackageRefresher } from '../work-package';
import { ALICE, GOOD_TOKEN, ORIGIN, createReplayWorld, type ReplayWorld } from './replay-world';

/** 2026-10-26 12:00:00 UTC, a Monday. */
export const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
export const TODAY = '2026-10-26';

export interface ServerInspection {
  /** ISO date-time, like the engine's list rows. */
  date: string;
  status: 'requested' | 'scheduled' | 'confirmed' | 'completed' | 'cancelled';
  inspectorId: string | null;
  /** Fields of the inspection row besides id and status. */
  row?: Record<string, unknown>;
}

export interface PackageRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string | undefined;
}

export type PackageScripted = HttpResponse | Error | undefined;

export interface PackageServer {
  http: Http;
  requests: PackageRequest[];
  inspections: Map<string, ServerInspection>;
  /** Bumped by a test to tell one download from the next; echoed in every body. */
  version: number;
  validToken: string;
  /** Answers consumed in order, for any request, before the normal handling. */
  script: PackageScripted[];
  /** Per-path answer; undefined falls through to the normal handling. */
  overrides: Map<string, (req: PackageRequest) => PackageScripted | Promise<PackageScripted>>;
  /** Runs after the request was recorded and before it is answered. */
  hook: ((request: PackageRequest, n: number) => void | Promise<void>) | null;
  maxInFlight(): number;
  /** Paths plus query, in the order the requests were made. */
  trail(): string[];
  /** Requests for one inspection, in order. */
  forInspection(id: string): string[];
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}, extra: Partial<HttpResponse> = {}): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8', ...headers }),
    text,
    json,
    retryAfterMs: null,
    upgrade: null,
    serverDateMs: null,
    ...extra,
  };
}

export const envelope = (data: unknown, meta?: unknown): unknown => ({ success: true, data, ...(meta === undefined ? {} : { meta }) });

function inspectionBody(server: PackageServer, id: string, found: ServerInspection): unknown {
  return envelope({ inspection: { id, status: found.status, date: found.date, inspectorId: found.inspectorId, propertyType: 'single_family', ...found.row }, v: server.version });
}

function listBody(server: PackageServer, query: URLSearchParams): unknown {
  const limit = Number(query.get('limit') ?? '20');
  const offset = Number(query.get('cursor') ?? '0');
  const matches = [...server.inspections.entries()].filter(([, i]) => {
    if (query.has('inspectorId') && i.inspectorId !== query.get('inspectorId')) return false;
    if (query.has('status') && i.status !== query.get('status')) return false;
    const day = i.date.slice(0, 10);
    if (query.has('dateFrom') && day < (query.get('dateFrom') ?? '')) return false;
    if (query.has('dateTo') && day > (query.get('dateTo') ?? '')) return false;
    return true;
  });
  const page = matches.slice(offset, offset + limit);
  const next = offset + limit < matches.length ? String(offset + limit) : null;
  return envelope(
    page.map(([id, i]) => ({ id, propertyAddress: `${id} Main St`, clientName: null, clientEmail: null, status: i.status, date: i.date, inspectorId: i.inspectorId, templateId: 't1', createdAt: '2026-01-01T00:00:00.000Z' })),
    { nextCursor: next },
  );
}

function handle(server: PackageServer, req: PackageRequest): HttpResponse {
  if (req.headers.Authorization !== `Bearer ${server.validToken}`) return jsonReply(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } });
  if (req.path === '/api/inspections') return jsonReply(200, listBody(server, req.query));
  const match = /^\/api\/inspections\/([^/]+)(\/.+)?$/.exec(req.path);
  if (match?.[1] !== undefined) {
    const id = match[1];
    const found = server.inspections.get(id);
    if (!found) return jsonReply(404, { success: false, error: { code: 'NOT_FOUND', message: 'gone' } });
    if (match[2] === undefined) return jsonReply(200, inspectionBody(server, id, found));
    return jsonReply(200, envelope({ path: req.path, v: server.version }));
  }
  return jsonReply(200, envelope({ path: req.path, v: server.version }));
}

export function createPackageServer(): PackageServer {
  const requests: PackageRequest[] = [];
  let inFlight = 0;
  let peak = 0;
  const server: PackageServer = {
    requests,
    inspections: new Map(),
    version: 1,
    validToken: GOOD_TOKEN,
    script: [],
    overrides: new Map(),
    hook: null,
    maxInFlight: () => peak,
    trail: () => requests.map((r) => r.path + (r.query.size > 0 ? `?${r.query.toString()}` : '')),
    forInspection: (id) => requests.filter((r) => r.path.startsWith(`/api/inspections/${id}`)).map((r) => r.path),
    http: {
      request: async (req: HttpRequest) => {
        const url = new URL(req.url);
        const recorded: PackageRequest = { method: req.method, url: req.url, path: url.pathname, query: url.searchParams, headers: { ...req.headers }, body: req.body };
        requests.push(recorded);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          if (server.hook) await server.hook(recorded, requests.length);
          const scripted = server.script.shift();
          if (scripted instanceof Error) throw scripted;
          if (scripted) return scripted;
          const override = server.overrides.get(url.pathname);
          if (override) {
            const answer = await override(recorded);
            if (answer instanceof Error) throw answer;
            if (answer) return answer;
          }
          return handle(server, recorded);
        } finally {
          inFlight -= 1;
        }
      },
    },
  };
  return server;
}

export const ALICE_KEY = accountKey(ALICE);

export interface PackageWorld extends ReplayWorld {
  pkg: PackageServer;
  refresher: WorkPackageRefresher;
  refreshHalts: string[];
  refreshErrors: unknown[];
  /** A refresher over the same database, clock and ports, for tests of two flows. */
  build(overrides?: Partial<RefresherDeps>): WorkPackageRefresher;
  /** Adds an inspection to the server. */
  serve(id: string, spec?: Partial<ServerInspection>): void;
  /** Inserts a server-confirmed package owned by the account. */
  seed(id: string, options?: { account?: Account; pinned?: number; confirmed?: number; refreshedAt?: number; gen?: number; quarantine?: string | null; purging?: number }): Promise<void>;
  cached(key: string, account?: string): Promise<string | null>;
  cachedKeys(id: string): Promise<string[]>;
  run(reason?: RefreshReason): Promise<RefreshSummary>;
}

export async function createPackageWorld(options: Partial<RefresherDeps> = {}): Promise<PackageWorld> {
  const world = await createReplayWorld();
  world.clock.set(NOW);
  const pkg = createPackageServer();
  const refreshHalts: string[] = [];
  const refreshErrors: unknown[] = [];
  let tokens = 0;
  const depsFor = (overrides: Partial<RefresherDeps> = {}): RefresherDeps => ({
    db: world.db,
    http: pkg.http,
    tokens: { getAccessToken: () => (world.state.tokenFn ? world.state.tokenFn() : Promise.resolve(world.state.token)), checkSession: () => (world.checkSession as unknown as () => Promise<SessionCheck>)() },
    origin: ORIGIN,
    clientHeaders: { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' },
    account: () => world.state.account,
    isLocked: () => {
      if (world.state.lockedThrows) throw new Error('lock state unreadable');
      return world.state.locked;
    },
    onUnlocked: (listener) => {
      world.unlockListeners.add(listener);
      return () => world.unlockListeners.delete(listener);
    },
    network: world.network,
    appState: world.appState,
    clock: world.clock,
    timers: world.timers,
    random: () => 0.5,
    newToken: () => `refresh-holder-${String((tokens += 1))}`,
    onHalt: (reason) => refreshHalts.push(reason),
    onError: (error) => refreshErrors.push(error),
    ...options,
    ...overrides,
  });
  const refresher = createWorkPackageRefresher(depsFor());
  const serve = (id: string, spec: Partial<ServerInspection> = {}): void => {
    pkg.inspections.set(id, { date: `${TODAY}T15:00:00.000Z`, status: 'scheduled', inspectorId: ALICE.userId, ...spec });
  };
  return Object.assign(world, {
    pkg,
    refresher,
    refreshHalts,
    refreshErrors,
    build: (overrides?: Partial<RefresherDeps>) => createWorkPackageRefresher(depsFor(overrides)),
    serve,
    seed: async (id: string, o: { account?: Account; pinned?: number; confirmed?: number; refreshedAt?: number; gen?: number; quarantine?: string | null; purging?: number } = {}) => {
      const account = o.account ?? ALICE;
      await world.db.run(
        'INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id, package_gen, quarantine_source, purging) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, o.refreshedAt ?? 0, o.pinned ?? 0, o.confirmed ?? 1, account.tenantId, account.userId, o.gen ?? 0, o.quarantine ?? null, o.purging ?? 0],
      );
    },
    cached: async (key: string, account: string = ALICE_KEY) => (await world.db.query<{ body: string }>('SELECT body FROM resource_cache WHERE account_key = ? AND key = ?', [account, key]))[0]?.body ?? null,
    cachedKeys: async (id: string) => (await world.db.query<{ key: string }>("SELECT key FROM resource_cache WHERE package_id = ? AND key <> '$refresh_error' ORDER BY key", [id])).map((r) => r.key),
    run: (reason: RefreshReason = 'manual') => refresher.refresh({ reason }),
  });
}
