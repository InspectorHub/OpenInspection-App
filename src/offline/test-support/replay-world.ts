import { vi } from 'vitest';
import { AuthError } from '../../auth/errors';
import type { Http, HttpRequest, HttpResponse } from '../../auth/http';
import type { SessionCheck } from '../../auth/tokens';
import { createManualTimers, type ManualTimers } from '../../collab/test-support/manual-timers';
import { createManualClock, type ManualClock } from '../../platform/clock';
import type { Db } from '../../platform/db';
import { createSqlJsDb } from '../../platform/db-sqljs';
import { migrate } from '../../platform/schema';
import { enqueue, listOutbox, type Account, type OutboxRow } from '../outbox';
import { createReplayer, type HaltReason, type ReplayDeps, type ReplayProgress, type Replayer } from '../replay';
import type { CommandRegistry } from '../registry';
import { fakeAppState, type FakeAppState } from './fakes';
import { neverBlocked } from '../../test-support/never-blocked';

export const ORIGIN = 'https://oi.example.test';
export const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
export const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };
export const GOOD_TOKEN = 'access-token-secret';

export function reply(status: number, body?: unknown, extra: Partial<HttpResponse> = {}): HttpResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { status, headers: new Headers(), text, json: body, retryAfterMs: null, upgrade: null, serverDateMs: null, ...extra };
}

export const ok = (id = 'x'): HttpResponse => reply(200, { success: true, data: { inspection: { id } } });
export const failure = (status: number, code: string, message = 'server wording that must never be stored'): HttpResponse => reply(status, { success: false, error: { code, message } });

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Scripted = HttpResponse | Error;

export interface FakeServer {
  http: Http;
  requests: RecordedRequest[];
  /** Inspections that exist on the server. */
  inspections: Map<string, { cancelled: boolean }>;
  /** Idempotency-Key to the answer it produced, like the server's 24 h window. */
  keys: Map<string, HttpResponse>;
  validToken: string;
  /** Ids the server answers 404 for (deleted, or never visible). */
  hidden: Set<string>;
  /** Ids the server answers 403 for (reassigned away). */
  forbidden: Set<string>;
  /** Answers consumed in order, before the normal handling; an Error is thrown from the request. */
  script: Scripted[];
  /** Runs after the request was recorded and before it is answered. */
  hook: ((request: RecordedRequest, n: number) => void | Promise<void>) | null;
  /** The server forgot every idempotency key (the window passed). */
  forgetKeys(): void;
}

function createFakeServer(): FakeServer {
  const requests: RecordedRequest[] = [];
  const server: FakeServer = {
    requests,
    inspections: new Map(),
    keys: new Map(),
    validToken: GOOD_TOKEN,
    hidden: new Set(),
    forbidden: new Set(),
    script: [],
    hook: null,
    forgetKeys: () => server.keys.clear(),
    http: {
      request: async (req: HttpRequest) => {
        const recorded: RecordedRequest = { method: req.method, url: req.url, headers: { ...req.headers }, body: req.body };
        requests.push(recorded);
        if (server.hook) await server.hook(recorded, requests.length);
        const scripted = server.script.shift();
        if (scripted instanceof Error) throw scripted;
        if (scripted) return scripted;
        return handle(server, recorded);
      },
    },
  };
  return server;
}

function handle(server: FakeServer, req: RecordedRequest): HttpResponse {
  if (req.headers.Authorization !== `Bearer ${server.validToken}`) return failure(401, 'UNAUTHORIZED');
  const key = req.headers['Idempotency-Key'] ?? '';
  const cached = server.keys.get(key);
  if (cached) return cached;
  const path = new URL(req.url).pathname;
  const remember = (res: HttpResponse): HttpResponse => {
    server.keys.set(key, res);
    return res;
  };
  if (req.method === 'POST' && path === '/api/inspections') {
    const id = (JSON.parse(req.body ?? '{}') as { id: string }).id;
    if (server.inspections.has(id)) return remember(ok(id));
    server.inspections.set(id, { cancelled: false });
    return remember(reply(201, { success: true, data: { inspection: { id } } }));
  }
  const match = /^\/api\/inspections\/([^/]+)(\/complete)?$/.exec(path);
  const id = match?.[1] ? decodeURIComponent(match[1]) : null;
  if (id === null) return failure(404, 'NOT_FOUND');
  if (server.forbidden.has(id)) return failure(403, 'FORBIDDEN');
  const found = server.inspections.get(id);
  if (server.hidden.has(id) || !found) return failure(404, 'NOT_FOUND');
  if (match?.[2] === '/complete' && found.cancelled) return failure(400, 'INSPECTION_CANCELLED');
  return remember(ok(id));
}

export interface FakeNetwork {
  online(): Promise<boolean>;
  onChange(cb: (online: boolean) => void): () => void;
  set(next: boolean): void;
  setQuietly(next: boolean): void;
  listeners(): number;
}

export function fakeNetwork(initial = true): FakeNetwork {
  let online = initial;
  const listeners = new Set<(online: boolean) => void>();
  return {
    online: () => Promise.resolve(online),
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next) {
      online = next;
      for (const l of [...listeners]) l(next);
    },
    setQuietly(next) {
      online = next;
    },
    listeners: () => listeners.size,
  };
}

export interface ReplayState {
  locked: boolean;
  lockedThrows: boolean;
  account: Account | null;
  token: string | null;
  /** Replaces the token read, for gating it. */
  tokenFn: (() => Promise<string | null>) | null;
  session: SessionCheck;
  /** Runs when checkSession is called (a refresh happened). */
  onCheckSession: (() => void) | null;
}

export interface ReplayWorld {
  db: Db;
  clock: ManualClock;
  timers: ManualTimers;
  network: FakeNetwork;
  appState: FakeAppState;
  server: FakeServer;
  state: ReplayState;
  replayer: Replayer;
  errors: unknown[];
  halts: HaltReason[];
  reconciles: string[];
  progress: ReplayProgress[];
  unlockListeners: Set<() => void>;
  checkSession: ReturnType<typeof vi.fn>;
  /** Queues one write through the real enqueue. */
  queue(op: string, input: unknown, account?: Account): Promise<OutboxRow>;
  rows(): Promise<OutboxRow[]>;
  /** Another replayer over the same database, clock and server: a second flow competing for the lease. */
  another(overrides?: Partial<ReplayDeps>): Replayer;
  unlock(): void;
  /** Requests whose url is not under the pinned origin. */
  stray(): RecordedRequest[];
}

export interface WorldOptions {
  registry?: CommandRegistry;
  fallbackIntervalMs?: number;
  leaseTtlMs?: number;
  clientHeaders?: Record<string, string>;
}

export const SESSION_OK: SessionCheck = { kind: 'ok', session: { userId: 'alice', tenantId: 'tenant-1', role: 'inspector', offlineMaxDays: 7 } };

export async function createReplayWorld(options: WorldOptions = {}): Promise<ReplayWorld> {
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const clock = createManualClock(1_000_000);
  const timers = createManualTimers();
  const network = fakeNetwork();
  const appState = fakeAppState();
  const server = createFakeServer();
  const state: ReplayState = { locked: false, lockedThrows: false, account: ALICE, token: GOOD_TOKEN, tokenFn: null, session: SESSION_OK, onCheckSession: null };
  const errors: unknown[] = [];
  const halts: HaltReason[] = [];
  const reconciles: string[] = [];
  const progress: ReplayProgress[] = [];
  const unlockListeners = new Set<() => void>();
  const checkSession = vi.fn(() => {
    state.onCheckSession?.();
    return Promise.resolve(state.session);
  });
  let ids = 0;
  const newId = () => `k${String((ids += 1))}`;
  let tokens = 0;

  const deps = (overrides: Partial<ReplayDeps> = {}): ReplayDeps => ({
    isBlocked: neverBlocked,
    db,
    http: server.http,
    tokens: { getAccessToken: () => (state.tokenFn ? state.tokenFn() : Promise.resolve(state.token)), checkSession },
    origin: ORIGIN,
    ...(options.registry ? { registry: options.registry } : {}),
    clientHeaders: options.clientHeaders ?? { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' },
    account: () => state.account,
    isLocked: () => {
      if (state.lockedThrows) throw new Error('lock state unreadable');
      return state.locked;
    },
    onUnlocked: (listener) => {
      unlockListeners.add(listener);
      return () => unlockListeners.delete(listener);
    },
    network,
    appState,
    clock,
    timers,
    random: () => 0.5,
    ...(options.fallbackIntervalMs === undefined ? {} : { fallbackIntervalMs: options.fallbackIntervalMs }),
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    newToken: () => `holder-${String((tokens += 1))}`,
    onNeedsReconcile: (id) => reconciles.push(id),
    onHalt: (reason) => halts.push(reason),
    onProgress: (p) => progress.push(p),
    onError: (error) => errors.push(error),
    ...overrides,
  });

  return {
    db,
    clock,
    timers,
    network,
    appState,
    server,
    state,
    replayer: createReplayer(deps()),
    errors,
    halts,
    reconciles,
    progress,
    unlockListeners,
    checkSession,
    queue: (op, input, account = ALICE) => enqueue({ db, clock, newId, ...(options.registry ? { registry: options.registry } : {}) }, op, input, { account }),
    rows: () => listOutbox(db),
    another: (overrides) => createReplayer(deps(overrides)),
    unlock: () => {
      for (const listener of [...unlockListeners]) listener();
    },
    stray: () => server.requests.filter((r) => !r.url.startsWith(`${ORIGIN}/`)),
  };
}

export const unreachable = (): Error => new AuthError('server_unreachable');
export const timedOut = (): Error => new AuthError('server_timeout');

/** Resolves when `fn` has been called once; for gating a request mid-flight. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
