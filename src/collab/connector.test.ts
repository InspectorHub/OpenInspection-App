import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth/errors';
import type { Http, HttpRequest, HttpResponse } from '../auth/http';
import type { SessionCheck, TokenManager } from '../auth/tokens';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import type { Network } from '../platform/network';
import { migrate } from '../platform/schema';
import {
  createCollabConnector,
  reconnectDelayMs,
  type CollabConnectorDeps,
  type CollabSocket,
  type CollabStatus,
  type SocketHandlers,
} from './connector';
import { createManualTimers, type ManualTimers } from './test-support/manual-timers';

const ORIGIN = 'https://oi.example.test';
const MSG_SYNC = 0;
const MSG_RESTORE = 2;

class FakeSocket implements CollabSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  private opened = false;

  constructor(
    readonly url: string,
    private readonly handlers: SocketHandlers,
  ) {}

  isOpen(): boolean {
    return this.opened && !this.closed;
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  serverOpens(): void {
    this.opened = true;
    this.handlers.open();
  }
  serverSends(data: Uint8Array): void {
    this.handlers.message(data);
  }
  serverCloses(): void {
    this.opened = false;
    this.handlers.close();
  }
}

/** Resolves a waiter when a list reaches a length; every wait is on a signal the code under test raises. */
class Signals<T> {
  readonly items: T[] = [];
  private waiters: { count: number; resolve: () => void }[] = [];
  push(item: T): void {
    this.items.push(item);
    this.waiters = this.waiters.filter((w) => {
      if (this.items.length < w.count) return true;
      w.resolve();
      return false;
    });
  }
  waitFor(count: number): Promise<void> {
    if (this.items.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }
}

function ticketReply(ticket: string, extra: Record<string, unknown> = {}): HttpResponse {
  return reply(200, { success: true, data: { ticket, expiresIn: 60, ...extra } });
}

function reply(status: number, json: unknown, retryAfterMs: number | null = null): HttpResponse {
  return { status, headers: new Headers(), text: JSON.stringify(json), json, retryAfterMs, upgrade: null, serverDateMs: null };
}

function frame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function messageKind(data: Uint8Array): number {
  const decoder = decoding.createDecoder(data);
  decoding.readVarUint(decoder);
  return decoding.readVarUint(decoder);
}

const STEP1 = syncProtocol.messageYjsSyncStep1;
const UPDATE = syncProtocol.messageYjsUpdate;

interface World {
  db: Db;
  timers: ManualTimers;
  requests: HttpRequest[];
  replies: (HttpResponse | Error)[];
  sockets: FakeSocket[];
  socketSignal: Signals<FakeSocket>;
  statuses: Signals<CollabStatus>;
  errors: unknown[];
  changes: Signals<null>;
  online: boolean;
  locked: boolean;
  emitOnline(online: boolean): void;
  tokens: { getAccessToken: ReturnType<typeof vi.fn>; checkSession: ReturnType<typeof vi.fn> };
  connector: ReturnType<typeof createCollabConnector>;
}

async function createWorld(overrides: Partial<CollabConnectorDeps> = {}, dbWrap?: (db: Db) => Db): Promise<World> {
  const realDb = await createSqlJsDb();
  await migrate(realDb, 0);
  const db = dbWrap ? dbWrap(realDb) : realDb;
  const timers = createManualTimers();
  const listeners = new Set<(online: boolean) => void>();
  const requests: HttpRequest[] = [];
  const sockets: FakeSocket[] = [];
  const socketSignal = new Signals<FakeSocket>();
  const world: World = {
    db: realDb,
    timers,
    requests,
    replies: [],
    sockets,
    socketSignal,
    statuses: new Signals<CollabStatus>(),
    errors: [],
    changes: new Signals<null>(),
    online: true,
    locked: false,
    emitOnline: (online) => {
      world.online = online;
      for (const listener of [...listeners]) listener(online);
    },
    tokens: {
      getAccessToken: vi.fn(() => Promise.resolve<string | null>('access-token-1')),
      checkSession: vi.fn(() => Promise.resolve<SessionCheck>({ kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } })),
    },
    connector: undefined as never,
  };
  let ticketNumber = 0;
  const http: Http = {
    request: (req) => {
      requests.push(req);
      const next = world.replies.shift();
      if (next instanceof Error) return Promise.reject(next);
      ticketNumber += 1;
      return Promise.resolve(next ?? ticketReply(`ticket-number-${String(ticketNumber).padStart(4, '0')}-abcdef`));
    },
  };
  const network: Network = {
    online: () => Promise.resolve(world.online),
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  world.connector = createCollabConnector({
    db,
    http,
    tokens: world.tokens as unknown as Pick<TokenManager, 'getAccessToken' | 'checkSession'>,
    network,
    origin: ORIGIN,
    isLocked: () => world.locked,
    openSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      socketSignal.push(socket);
      return socket;
    },
    timers,
    random: () => 1,
    onError: (error) => world.errors.push(error),
    onStatus: (_id, status) => world.statuses.push(status),
    ...overrides,
  });
  return world;
}

async function barrier(db: Db): Promise<void> {
  await db.query('SELECT 1');
}

async function rows(db: Db, docName: string): Promise<number> {
  const result = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [docName]);
  return Number(result[0]?.n);
}

function connect(world: World, id = 'insp-1'): ReturnType<World['connector']['connect']> {
  return world.connector.connect(id, { onChange: () => world.changes.push(null) });
}

function url(socket: FakeSocket): URL {
  return new URL(socket.url);
}

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

describe('connect: local state first, then the network', () => {
  it('asks for no ticket until the stored state has been applied', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    world = await createWorld({}, (real) => ({
      ...real,
      query: async (sql, params) => {
        await held;
        return real.query(sql, params);
      },
    }));
    const handle = connect(world);
    await Promise.resolve();
    await Promise.resolve();
    expect(world.requests).toHaveLength(0);
    expect(world.sockets).toHaveLength(0);

    release();
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    expect(world.requests).toHaveLength(1);
    handle.destroy();
  });

  it('restores the stored content into the live document before any socket opens', async () => {
    const seed = new Y.Doc();
    seed.getMap<unknown>('m').set('k', 'stored');
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-insp-1', Y.encodeStateAsUpdate(seed)]);

    const handle = connect(world);
    await handle.persistenceSynced;
    expect(handle.doc.getMap<unknown>('m').get('k')).toBe('stored');
    expect(handle.synced()).toBe(false);
    handle.destroy();
  });

  it('never opens a socket when the stored state cannot be read, and reports it', async () => {
    world = await createWorld({}, (real) => ({ ...real, query: () => Promise.reject(new Error('read failed')) }));
    const handle = connect(world);
    await vi.waitFor(() => {
      expect(world.errors).toHaveLength(1);
    });
    expect(world.requests).toHaveLength(0);
    expect(world.sockets).toHaveLength(0);
    handle.destroy();
  });

  it('asks the server for a ticket with the access token, and opens the pinned socket with it', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);

    expect(world.requests).toHaveLength(1);
    const request = world.requests[0] as HttpRequest;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${ORIGIN}/api/inspections/insp-1/collab/ticket`);
    expect(request.headers).toEqual({ Authorization: 'Bearer access-token-1' });

    const socket = world.sockets[0] as FakeSocket;
    const opened = url(socket);
    expect(opened.origin).toBe('wss://oi.example.test');
    expect(opened.pathname).toBe('/api/inspections/insp-1/collab/ws');
    expect(opened.searchParams.get('ticket')).toBe('ticket-number-0001-abcdef');
    handle.destroy();
  });

  it('starts the sync with a step 1 when the socket opens, and is synced after the step 2', async () => {
    const onSynced = vi.fn();
    const handle = world.connector.connect('insp-1', { onSynced, onChange: () => world.changes.push(null) });
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    expect(socket.sent).toHaveLength(0);

    socket.serverOpens();
    expect(socket.sent).toHaveLength(1);
    expect(messageKind(socket.sent[0] as Uint8Array)).toBe(STEP1);
    expect(handle.synced()).toBe(false);

    const server = new Y.Doc();
    server.getMap<unknown>('m').set('remote', 'x');
    socket.serverSends(frame((e) => syncProtocol.writeSyncStep2(e, server)));
    expect(handle.synced()).toBe(true);
    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(handle.doc.getMap<unknown>('m').get('remote')).toBe('x');
    handle.destroy();
  });
});

describe('connect: the pinned origin', () => {
  it('uses only the stored origin, whatever the ticket answer carries', async () => {
    world.replies.push(ticketReply('ticket-number-0001-abcdef', { url: 'wss://evil.example/steal', wsUrl: 'wss://evil.example', origin: 'https://evil.example' }));
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    expect(url(world.sockets[0] as FakeSocket).host).toBe('oi.example.test');
    expect(world.sockets.every((s) => !s.url.includes('evil.example'))).toBe(true);
    handle.destroy();
  });

  it('turns an http loopback origin into ws, and refuses a plain-http remote origin', async () => {
    const local = await createWorld({ origin: 'http://localhost:8787' });
    const handle = connect(local);
    await local.socketSignal.waitFor(1);
    expect(local.sockets[0]?.url.startsWith('ws://localhost:8787/api/inspections/insp-1/collab/ws?ticket=')).toBe(true);
    handle.destroy();

    await expect(createWorld({ origin: 'http://lan.example.test:8787' })).rejects.toBeInstanceOf(AuthError);
    const allowed = await createWorld({ origin: 'http://lan.example.test:8787', allowInsecureHttp: true });
    const second = connect(allowed);
    await allowed.socketSignal.waitFor(1);
    expect(allowed.sockets[0]?.url.startsWith('ws://lan.example.test:8787/')).toBe(true);
    second.destroy();
  });

  it('refuses an origin with a path, and an inspection id outside the id charset', async () => {
    await expect(createWorld({ origin: 'https://oi.example.test/app' })).rejects.toBeInstanceOf(AuthError);
    for (const bad of ['', '../x', 'a b', 'a/b', 'a?ticket=1', 'x'.repeat(65)]) {
      expect(() => world.connector.connect(bad, {})).toThrow(RangeError);
    }
    expect(world.requests).toHaveLength(0);
    const ok = world.connector.connect('abc_DEF-123', {});
    ok.destroy();
  });
});

describe('reconnecting', () => {
  it('computes an exponential delay with jitter and a ceiling', () => {
    expect([0, 1, 2, 3].map((n) => reconnectDelayMs(n, () => 1))).toEqual([400, 800, 1600, 3200]);
    expect([0, 1, 2, 3].map((n) => reconnectDelayMs(n, () => 0))).toEqual([200, 400, 800, 1600]);
    expect(reconnectDelayMs(30, () => 1)).toBe(30_000);
    expect(reconnectDelayMs(30, () => 0)).toBe(15_000);
    expect(reconnectDelayMs(0, () => 0.5)).toBe(300);
  });

  it('fetches a new ticket for every reconnect, and backs off while sockets keep failing', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const tickets: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      tickets.push(url(world.sockets[i] as FakeSocket).searchParams.get('ticket') ?? '');
      (world.sockets[i] as FakeSocket).serverCloses();
      await world.statuses.waitFor(2 * (i + 1));
      expect(world.timers.pending()).toBe(1);
      world.timers.fireNext();
      await world.socketSignal.waitFor(i + 2);
    }
    tickets.push(url(world.sockets[3] as FakeSocket).searchParams.get('ticket') ?? '');
    expect(new Set(tickets).size).toBe(4);
    expect(world.requests).toHaveLength(4);
    expect(world.timers.requested()).toEqual([400, 800, 1600]);
    handle.destroy();
  });

  it('starts the backoff over after a sync', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    (world.sockets[0] as FakeSocket).serverCloses();
    world.timers.fireNext();
    await world.socketSignal.waitFor(2);
    const second = world.sockets[1] as FakeSocket;
    second.serverOpens();
    second.serverSends(frame((e) => syncProtocol.writeSyncStep2(e, new Y.Doc())));
    second.serverCloses();
    expect(world.timers.requested()).toEqual([400, 400]);
    handle.destroy();
  });

  it('ignores the close of a socket that is no longer the current one', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const first = world.sockets[0] as FakeSocket;
    first.serverCloses();
    world.timers.fireNext();
    await world.socketSignal.waitFor(2);
    first.serverCloses();
    expect(world.timers.pending()).toBe(0);
    handle.destroy();
  });

  it('retries a ticket request that fails on the network, with the same backoff', async () => {
    world.replies.push(new AuthError('server_unreachable'));
    const handle = connect(world);
    await world.statuses.waitFor(2);
    expect(world.statuses.items.slice(0, 2)).toEqual(['connecting', 'retrying']);
    expect(world.timers.requested()).toEqual([400]);
    world.timers.fireNext();
    await world.socketSignal.waitFor(1);
    expect(world.requests).toHaveLength(2);
    handle.destroy();
  });

  it('waits at least as long as the server asked on 429 and 503', async () => {
    world.replies.push(reply(503, { error: 'busy' }, 5_000));
    const handle = connect(world);
    await world.statuses.waitFor(2);
    expect(world.timers.requested()).toEqual([5_000]);
    handle.destroy();
  });

  it('does not retry when the server refuses this device for this inspection, or for this version', async () => {
    for (const [status, expected] of [
      [403, 'denied'],
      [404, 'denied'],
      [426, 'upgrade_required'],
    ] as const) {
      const w = await createWorld();
      w.replies.push(reply(status, { error: 'no' }));
      const handle = connect(w);
      await w.statuses.waitFor(2);
      expect(w.statuses.items).toEqual(['connecting', expected]);
      expect(w.timers.pending()).toBe(0);
      expect(w.sockets).toHaveLength(0);
      w.emitOnline(true);
      await barrier(w.db);
      expect(w.requests).toHaveLength(1);
      handle.destroy();
    }
    world.replies.push(reply(500, { error: 'boom' }));
    const retried = connect(world);
    await world.statuses.waitFor(2);
    expect(world.timers.pending()).toBe(1);
    retried.destroy();
  });

  it('ignores a ticket that is not shaped like one', async () => {
    world.replies.push(ticketReply('short'), ticketReply('has spaces in it, not allowed'), reply(200, { success: true, data: {} }));
    const handle = connect(world);
    for (let i = 0; i < 3; i += 1) {
      await world.statuses.waitFor(2 * (i + 1));
      world.timers.fireNext();
    }
    await world.socketSignal.waitFor(1);
    expect(world.requests).toHaveLength(4);
    expect(world.sockets).toHaveLength(1);
    expect(url(world.sockets[0] as FakeSocket).searchParams.get('ticket')).toBe('ticket-number-0004-abcdef');
    handle.destroy();
  });
});

describe('when the ticket is refused for authentication', () => {
  it('stops after a bounded number of refusals, clears nothing and does not loop', async () => {
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-insp-1', Uint8Array.from([0, 0])]);
    for (let i = 0; i < 10; i += 1) world.replies.push(reply(401, { error: 'unauthorized' }));
    const handle = connect(world);

    for (let attempt = 1; attempt < 3; attempt += 1) {
      await world.statuses.waitFor(2 * attempt);
      world.timers.fireNext();
    }
    await world.statuses.waitFor(6);
    expect(world.statuses.items[5]).toBe('auth_rejected');
    expect(world.requests).toHaveLength(3);
    expect(world.tokens.checkSession).toHaveBeenCalledTimes(3);
    expect(world.timers.pending()).toBe(0);

    world.emitOnline(true);
    await barrier(world.db);
    expect(world.requests).toHaveLength(3);
    expect(await rows(world.db, 'results-insp-1')).toBe(1);
    handle.destroy();
  });

  it('stops at once when the token manager says the session is over', async () => {
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-insp-1', Uint8Array.from([0, 0])]);
    world.replies.push(reply(401, { error: 'unauthorized' }));
    world.tokens.checkSession.mockResolvedValue({ kind: 'relogin' });
    const handle = connect(world);
    await world.statuses.waitFor(2);
    expect(world.statuses.items).toEqual(['connecting', 'signed_out']);
    expect(world.requests).toHaveLength(1);
    expect(world.timers.pending()).toBe(0);
    expect(await rows(world.db, 'results-insp-1')).toBe(1);
    handle.destroy();
  });

  it('asks the token manager when there is no access token, and retries when it only says "later"', async () => {
    world.tokens.getAccessToken.mockResolvedValueOnce(null);
    world.tokens.checkSession.mockResolvedValueOnce({ kind: 'retry', reason: 'network', retryAfterMs: 7_000 });
    const handle = connect(world);
    await world.statuses.waitFor(2);
    expect(world.requests).toHaveLength(0);
    expect(world.tokens.checkSession).toHaveBeenCalledWith(ORIGIN);
    expect(world.timers.requested()).toEqual([7_000]);
    world.timers.fireNext();
    await world.socketSignal.waitFor(1);
    expect(world.requests).toHaveLength(1);
    handle.destroy();
  });

  it('counts only refusals in a row: a good ticket starts the count over', async () => {
    world.replies.push(reply(401, {}), reply(401, {}));
    const handle = connect(world);
    await world.statuses.waitFor(2);
    world.timers.fireNext();
    await world.statuses.waitFor(4);
    world.timers.fireNext();
    await world.socketSignal.waitFor(1);
    (world.sockets[0] as FakeSocket).serverCloses();
    world.replies.push(reply(401, {}), reply(401, {}));
    await world.statuses.waitFor(6);
    world.timers.fireNext();
    await world.statuses.waitFor(8);
    world.timers.fireNext();
    await world.statuses.waitFor(10);
    world.timers.fireNext();
    await world.socketSignal.waitFor(2);
    expect(world.statuses.items).not.toContain('auth_rejected');
    expect(world.requests).toHaveLength(6);
    handle.destroy();
  });
});

describe('offline and locked devices', () => {
  it('makes no attempt while offline, and connects when the network returns', async () => {
    world.online = false;
    const handle = connect(world);
    await world.statuses.waitFor(1);
    expect(world.statuses.items).toEqual(['offline']);
    expect(world.requests).toHaveLength(0);
    expect(world.timers.pending()).toBe(0);

    world.emitOnline(true);
    await world.socketSignal.waitFor(1);
    expect(world.requests).toHaveLength(1);
    handle.destroy();
  });

  it('drops the socket and schedules nothing when the network goes away', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    world.emitOnline(false);
    expect(socket.closed).toBe(true);
    socket.serverCloses();
    expect(world.timers.pending()).toBe(0);
    expect(world.statuses.items.at(-1)).toBe('offline');

    world.emitOnline(true);
    await world.socketSignal.waitFor(2);
    expect(world.requests).toHaveLength(2);
    handle.destroy();
  });

  it('does not connect on a locked device, and connects once it is unlocked', async () => {
    world.locked = true;
    const handle = connect(world);
    await world.statuses.waitFor(1);
    expect(world.statuses.items).toEqual(['locked']);
    expect(world.requests).toHaveLength(0);
    world.emitOnline(true);
    await barrier(world.db);
    await Promise.resolve();
    expect(world.requests).toHaveLength(0);

    world.locked = false;
    world.connector.onLockChange();
    await world.socketSignal.waitFor(1);
    expect(world.requests).toHaveLength(1);
    handle.destroy();
  });

  it('closes a live socket when the device becomes locked, and stays quiet', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();

    world.locked = true;
    world.connector.onLockChange();
    await world.statuses.waitFor(2);
    expect(world.statuses.items.at(-1)).toBe('locked');
    expect(socket.closed).toBe(true);
    socket.serverCloses();
    expect(world.timers.pending()).toBe(0);
    expect(world.requests).toHaveLength(1);
    handle.destroy();
  });

  it('treats a failing lock check as locked', async () => {
    const failing = await createWorld({
      isLocked: () => Promise.reject(new Error('lock state unreadable')),
    });
    const handle = connect(failing);
    await failing.statuses.waitFor(1);
    expect(failing.statuses.items).toEqual(['locked']);
    expect(failing.requests).toHaveLength(0);
    handle.destroy();
  });
});

describe('messages from the socket', () => {
  it('applies an update from the server to the document and stores it once', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();

    const server = new Y.Doc();
    server.getMap<unknown>('m').set('remote', 'hello');
    socket.serverSends(frame((e) => syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(server))));
    expect(handle.doc.getMap<unknown>('m').get('remote')).toBe('hello');
    await barrier(world.db);
    expect(await rows(world.db, 'results-insp-1')).toBe(1);
    expect(socket.sent).toHaveLength(1);
    handle.destroy();
  });

  it('sends a local edit to the server once, and stores it once', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    handle.doc.getMap<unknown>('m').set('local', 1);
    await barrier(world.db);

    const updates = socket.sent.filter((m) => messageKind(m) === UPDATE);
    expect(updates).toHaveLength(1);
    expect(await rows(world.db, 'results-insp-1')).toBe(1);
    handle.destroy();
  });

  it('answers a server step 1 with a step 2 of the local state', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    handle.doc.getMap<unknown>('m').set('mine', 1);
    const server = new Y.Doc();
    socket.serverSends(frame((e) => syncProtocol.writeSyncStep1(e, server)));
    const step2 = socket.sent.filter((m) => messageKind(m) === syncProtocol.messageYjsSyncStep2);
    expect(step2).toHaveLength(1);
    handle.destroy();
  });

  it('ignores frames that are empty or of an unknown kind', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    socket.serverSends(new Uint8Array(0));
    socket.serverSends(Uint8Array.from([7, 1, 2, 3]));
    expect(handle.synced()).toBe(false);
    expect(world.errors).toEqual([]);
    handle.destroy();
  });

  it('drops local state and resyncs when the server announces a version restore', async () => {
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    handle.doc.getMap<unknown>('m').set('stale', 1);
    await barrier(world.db);
    expect(await rows(world.db, 'results-insp-1')).toBe(1);
    const before = handle.doc;
    const changesBefore = world.changes.items.length;

    socket.serverSends(Uint8Array.from([MSG_RESTORE]));
    await world.changes.waitFor(changesBefore + 1);
    expect(handle.doc).not.toBe(before);
    expect(handle.doc.getMap<unknown>('m').get('stale')).toBeUndefined();
    expect(handle.synced()).toBe(false);
    expect(await rows(world.db, 'results-insp-1')).toBe(0);
    expect(socket.sent.filter((m) => messageKind(m) === STEP1)).toHaveLength(2);

    const restored = new Y.Doc();
    restored.getMap<unknown>('m').set('restored', true);
    socket.serverSends(frame((e) => syncProtocol.writeSyncStep2(e, restored)));
    expect(handle.doc.getMap<unknown>('m').get('restored')).toBe(true);
    expect(handle.synced()).toBe(true);
    await barrier(world.db);
    expect(await rows(world.db, 'results-insp-1')).toBe(1);
    handle.destroy();
  });
});

describe('destroy and purge', () => {
  it('cancels a pending reconnect and closes the socket', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const first = world.sockets[0] as FakeSocket;
    first.serverCloses();
    expect(world.timers.pending()).toBe(1);
    handle.destroy();
    expect(world.timers.pending()).toBe(0);

    const live = connect(world, 'insp-2');
    await world.socketSignal.waitFor(2);
    const second = world.sockets[1] as FakeSocket;
    live.destroy();
    live.destroy();
    expect(second.closed).toBe(true);
    expect(world.requests).toHaveLength(2);
  });

  it('does not open a socket for a ticket that arrives after destroy', async () => {
    let answer: (response: HttpResponse) => void = () => undefined;
    const held = await createWorld({
      http: {
        request: () =>
          new Promise<HttpResponse>((resolve) => {
            answer = resolve;
          }),
      },
    });
    const handle = connect(held);
    await held.statuses.waitFor(1);
    handle.destroy();
    answer(ticketReply('ticket-number-0001-abcdef'));
    await barrier(held.db);
    await Promise.resolve();
    expect(held.sockets).toHaveLength(0);
  });

  it('purge deletes that inspection rows, closes its socket and leaves other inspections alone', async () => {
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    handle.doc.getMap<unknown>('m').set('k', 1);
    handle.doc.getMap<unknown>('m').set('j', 2);
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-insp-2', Uint8Array.from([0, 0])]);
    await barrier(world.db);
    expect(await rows(world.db, 'results-insp-1')).toBe(2);

    await world.connector.purge('insp-1');
    expect(socket.closed).toBe(true);
    expect(await rows(world.db, 'results-insp-1')).toBe(0);
    expect(await rows(world.db, 'results-insp-2')).toBe(1);

    handle.doc.getMap<unknown>('m').set('after', 3);
    await barrier(world.db);
    expect(await rows(world.db, 'results-insp-1')).toBe(0);
    expect(world.timers.pending()).toBe(0);
  });

  it('purge deletes the rows of an inspection that has no live connection, and rejects an invalid id', async () => {
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-insp-9', Uint8Array.from([0, 0])]);
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-insp-90', Uint8Array.from([0, 0])]);
    await world.connector.purge('insp-9');
    expect(await rows(world.db, 'results-insp-9')).toBe(0);
    expect(await rows(world.db, 'results-insp-90')).toBe(1);

    await expect(world.connector.purge("x' OR '1'='1")).rejects.toBeInstanceOf(RangeError);
    await expect(world.connector.purge('%')).rejects.toBeInstanceOf(RangeError);
    expect(await rows(world.db, 'results-insp-90')).toBe(1);
  });
});

describe('what is reported', () => {
  it('never puts the ticket or the token into a status or an error', async () => {
    const hostile = await createWorld({
      openSocket: (socketUrl) => {
        throw new Error(`Failed to construct 'WebSocket': The URL '${socketUrl}' is invalid.`);
      },
    });
    const handle = connect(hostile);
    await hostile.statuses.waitFor(2);
    expect(hostile.errors).toHaveLength(1);
    const text = JSON.stringify([hostile.statuses.items, hostile.errors.map((e) => (e as Error).message)]);
    expect(text).not.toContain('ticket-number');
    expect(text).not.toContain('access-token');
    expect(hostile.timers.pending()).toBe(1);
    handle.destroy();
  });
});

/** Lets every already-resolved promise chain run; the code under test has no timer or I/O in these steps. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** An http port that answers only when the test says so; `pending.items[n]` answers the nth request. */
function heldHttp(): { http: Http; pending: Signals<(response: HttpResponse) => void> } {
  const pending = new Signals<(response: HttpResponse) => void>();
  return {
    http: {
      request: () =>
        new Promise<HttpResponse>((resolve) => {
          pending.push(resolve);
        }),
    },
    pending,
  };
}

function ticketOf(socket: FakeSocket): string {
  return url(socket).searchParams.get('ticket') ?? '';
}

describe('one connection per inspection', () => {
  it('refuses a second connection for an inspection that is still connected, and says why', async () => {
    const first = connect(world);
    await world.socketSignal.waitFor(1);
    expect(() => connect(world)).toThrow(/already open/);
    await settle();
    expect(world.sockets).toHaveLength(1);
    expect(world.requests).toHaveLength(1);
    first.destroy();
  });

  it('allows the next connection as soon as the first was destroyed, and another inspection at any time', async () => {
    const first = connect(world);
    await world.socketSignal.waitFor(1);
    const other = connect(world, 'insp-2');
    first.destroy();
    const second = connect(world);
    await world.socketSignal.waitFor(3);
    expect(world.sockets).toHaveLength(3);
    second.destroy();
    other.destroy();
  });
});

describe('isOpen: the media code asks before it would open a second document', () => {
  it('is true while a connection is live, false before the first and from the moment it is destroyed', async () => {
    expect(world.connector.isOpen('insp-1')).toBe(false);
    const first = connect(world);
    await world.socketSignal.waitFor(1);
    expect(world.connector.isOpen('insp-1')).toBe(true);
    expect(world.connector.isOpen('insp-2')).toBe(false);
    first.destroy();
    expect(world.connector.isOpen('insp-1')).toBe(false);
  });

  it('is false for an id the connector would refuse', () => {
    expect(world.connector.isOpen('../x')).toBe(false);
    expect(world.connector.isOpen('')).toBe(false);
  });
});

describe('an attempt that the world overtook', () => {
  it('connects again when the network went away and came back while a ticket was being fetched', async () => {
    const held = heldHttp();
    world = await createWorld({ http: held.http });
    const handle = connect(world);
    await held.pending.waitFor(1);

    world.emitOnline(false);
    world.emitOnline(true);
    (held.pending.items[0] as (r: HttpResponse) => void)(ticketReply('ticket-number-0001-abcdef'));
    await held.pending.waitFor(2);
    (held.pending.items[1] as (r: HttpResponse) => void)(ticketReply('ticket-number-0002-abcdef'));
    await world.socketSignal.waitFor(1);

    expect(world.sockets).toHaveLength(1);
    expect(ticketOf(world.sockets[0] as FakeSocket)).toBe('ticket-number-0002-abcdef');
    handle.destroy();
  }, 1000);

  it('connects again when the device was locked and unlocked while a token was being fetched', async () => {
    const gateToken = new Signals<(token: string | null) => void>();
    world.tokens.getAccessToken.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          gateToken.push(resolve);
        }),
    );
    const handle = connect(world);
    await gateToken.waitFor(1);

    world.locked = true;
    world.connector.onLockChange();
    await settle();
    expect(world.statuses.items.at(-1)).toBe('locked');
    world.locked = false;
    world.connector.onLockChange();
    await settle();
    (gateToken.items[0] as (token: string | null) => void)('access-token-1');
    await world.socketSignal.waitFor(1);

    expect(world.sockets).toHaveLength(1);
    expect(world.requests).toHaveLength(2);
    expect(ticketOf(world.sockets[0] as FakeSocket)).toBe('ticket-number-0002-abcdef');
    handle.destroy();
  }, 1000);

  it('opens no socket for a ticket that arrives after the network went away, and schedules nothing', async () => {
    const held = heldHttp();
    world = await createWorld({ http: held.http });
    const handle = connect(world);
    await held.pending.waitFor(1);

    world.emitOnline(false);
    (held.pending.items[0] as (r: HttpResponse) => void)(ticketReply('ticket-number-0001-abcdef'));
    await settle();
    expect(world.sockets).toHaveLength(0);
    expect(world.timers.pending()).toBe(0);
    expect(world.statuses.items.at(-1)).toBe('offline');
    handle.destroy();
  });

  it('opens no socket for a ticket that arrives after the device was locked, and schedules nothing', async () => {
    const held = heldHttp();
    world = await createWorld({ http: held.http });
    const handle = connect(world);
    await held.pending.waitFor(1);

    world.locked = true;
    world.connector.onLockChange();
    await settle();
    (held.pending.items[0] as (r: HttpResponse) => void)(ticketReply('ticket-number-0001-abcdef'));
    await settle();
    expect(world.sockets).toHaveLength(0);
    expect(world.timers.pending()).toBe(0);
    expect(world.statuses.items.at(-1)).toBe('locked');
    handle.destroy();
  });
});

describe('no socket before the stored state is applied', () => {
  async function worldWithHeldRead(): Promise<Signals<() => void>> {
    const hold = new Signals<() => void>();
    world = await createWorld({}, (real) => ({
      ...real,
      query: async (sql, params) => {
        await new Promise<void>((resolve) => {
          hold.push(resolve);
        });
        return real.query(sql, params);
      },
    }));
    return hold;
  }

  it('ignores a network-online event while the stored state is still being read', async () => {
    const hold = await worldWithHeldRead();
    const handle = connect(world);
    await hold.waitFor(1);

    world.emitOnline(true);
    await settle();
    expect(world.requests).toHaveLength(0);
    expect(world.sockets).toHaveLength(0);

    (hold.items[0] as () => void)();
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    expect(world.requests).toHaveLength(1);
    handle.destroy();
  });

  it('ignores a lock change while the stored state is still being read', async () => {
    const hold = await worldWithHeldRead();
    const handle = connect(world);
    await hold.waitFor(1);

    world.connector.onLockChange();
    await settle();
    expect(world.requests).toHaveLength(0);
    (hold.items[0] as () => void)();
    await world.socketSignal.waitFor(1);
    expect(world.requests).toHaveLength(1);
    handle.destroy();
  });

  it('never connects on a document that cannot be stored: not on online, not on a lock change, and says so', async () => {
    world = await createWorld({}, (real) => ({ ...real, query: () => Promise.reject(new Error('read failed')) }));
    const handle = connect(world);
    await world.statuses.waitFor(1);
    expect(world.statuses.items).toEqual(['storage_failed']);

    world.emitOnline(false);
    world.emitOnline(true);
    world.connector.onLockChange();
    await settle();
    expect(world.requests).toHaveLength(0);
    expect(world.sockets).toHaveLength(0);
    expect(world.timers.pending()).toBe(0);
    handle.destroy();
  });
});

describe('frames that cannot be read', () => {
  const MALFORMED: [string, Uint8Array][] = [
    ['a truncated length', Uint8Array.from([0x80])],
    ['a sync step 2 that claims more bytes than it has', Uint8Array.from([MSG_SYNC, syncProtocol.messageYjsSyncStep2, 9])],
    ['an update that is not an update', Uint8Array.from([MSG_SYNC, UPDATE, 4, 255, 255, 255, 255])],
  ];

  it.each(MALFORMED)('reports %s generically, drops the socket and reconnects with a new ticket', async (_name, bytes) => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();

    expect(() => socket.serverSends(bytes)).not.toThrow();
    expect(socket.closed).toBe(true);
    expect(world.errors).toHaveLength(1);
    const text = JSON.stringify(world.errors.map((e) => (e as Error).message));
    expect(text).not.toContain('ticket-number');
    expect(text).not.toContain(ORIGIN);
    expect(world.timers.pending()).toBe(1);
    expect(world.statuses.items.at(-1)).toBe('retrying');

    socket.serverCloses();
    expect(world.timers.pending()).toBe(1);
    world.timers.fireNext();
    await world.socketSignal.waitFor(2);
    expect(ticketOf(world.sockets[1] as FakeSocket)).not.toBe(ticketOf(socket));
    handle.destroy();
  });

  it('control: a well-formed frame in the same place reports nothing and keeps the socket', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    socket.serverSends(frame((e) => syncProtocol.writeSyncStep2(e, new Y.Doc())));
    expect(world.errors).toEqual([]);
    expect(socket.closed).toBe(false);
    expect(world.timers.pending()).toBe(0);
    handle.destroy();
  });
});

describe('a version restore in progress', () => {
  it('does not reconnect while the document is being replaced, and reconnects once it is', async () => {
    const deleting = new Signals<() => void>();
    world = await createWorld({}, (real) => ({
      ...real,
      run: async (sql, params) => {
        if (sql.startsWith('DELETE FROM ydoc_updates')) {
          await new Promise<void>((resolve) => {
            deleting.push(resolve);
          });
        }
        return real.run(sql, params);
      },
    }));
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    const changesBefore = world.changes.items.length;

    socket.serverSends(Uint8Array.from([MSG_RESTORE]));
    await deleting.waitFor(1);
    socket.serverCloses();
    await settle();
    expect(world.timers.pending()).toBe(0);
    expect(world.sockets).toHaveLength(1);

    (deleting.items[0] as () => void)();
    await world.changes.waitFor(changesBefore + 1);
    expect(world.timers.pending()).toBe(1);
    world.timers.fireNext();
    await world.socketSignal.waitFor(2);
    handle.destroy();
  }, 1000);
});

describe('how long a reconnect may wait', () => {
  it('never waits longer than five minutes, whatever the server asked for', async () => {
    world.replies.push(reply(503, { error: 'busy' }, 3_600_000));
    const handle = connect(world);
    await world.statuses.waitFor(2);
    expect(world.timers.requested()).toEqual([300_000]);
    handle.destroy();
  });

  it('control: a request just under the cap is honoured as asked', async () => {
    world.replies.push(reply(503, { error: 'busy' }, 299_000));
    const handle = connect(world);
    await world.statuses.waitFor(2);
    expect(world.timers.requested()).toEqual([299_000]);
    handle.destroy();
  });
});

describe('purge waits for the connection to finish', () => {
  it('closes the socket now, and deletes the rows only after a write already started has landed', async () => {
    const log: string[] = [];
    const insertStarted = new Signals<() => void>();
    world = await createWorld({}, (real) => ({
      ...real,
      run: async (sql, params) => {
        if (sql.startsWith('INSERT')) {
          log.push('insert-started');
          await new Promise<void>((resolve) => {
            insertStarted.push(resolve);
          });
          const result = await real.run(sql, params);
          log.push('insert-done');
          return result;
        }
        if (sql.startsWith('DELETE FROM ydoc_updates')) log.push('delete');
        return real.run(sql, params);
      },
      // The purge deletes inside a transaction; its statements are logged the same way.
      transaction: (fn) =>
        real.transaction((tx) =>
          fn({
            ...tx,
            run: (sql, params) => {
              if (sql.startsWith('DELETE FROM ydoc_updates')) log.push('delete');
              return tx.run(sql, params);
            },
          }),
        ),
    }));
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    handle.doc.getMap<unknown>('m').set('k', 1);
    await insertStarted.waitFor(1);

    const purged = world.connector.purge('insp-1');
    expect(socket.closed).toBe(true);
    await barrier(world.db);
    await settle();
    expect(log).toEqual(['insert-started']);

    (insertStarted.items[0] as () => void)();
    await purged;
    expect(log).toEqual(['insert-started', 'insert-done', 'delete']);
    expect(await rows(world.db, 'results-insp-1')).toBe(0);
  });
});

describe('a server that never accepts the upgrade', () => {
  it('reports unreachable after five sockets in a row that never opened, and keeps retrying', async () => {
    const handle = connect(world);
    for (let i = 0; i < 5; i += 1) {
      await world.socketSignal.waitFor(i + 1);
      expect(world.statuses.items).not.toContain('unreachable');
      (world.sockets[i] as FakeSocket).serverCloses();
      if (i < 4) world.timers.fireNext();
    }
    expect(world.statuses.items.at(-1)).toBe('unreachable');
    expect(world.timers.pending()).toBe(1);

    world.timers.fireNext();
    await world.socketSignal.waitFor(6);
    handle.destroy();
  });

  it('control: sockets that opened before they closed never count', async () => {
    const handle = connect(world);
    for (let i = 0; i < 7; i += 1) {
      await world.socketSignal.waitFor(i + 1);
      const socket = world.sockets[i] as FakeSocket;
      socket.serverOpens();
      socket.serverCloses();
      world.timers.fireNext();
    }
    expect(world.statuses.items).not.toContain('unreachable');
    handle.destroy();
  });

  it('control: a completed sync starts the count over', async () => {
    const handle = connect(world);
    for (let i = 0; i < 4; i += 1) {
      await world.socketSignal.waitFor(i + 1);
      (world.sockets[i] as FakeSocket).serverCloses();
      world.timers.fireNext();
    }
    await world.socketSignal.waitFor(5);
    const good = world.sockets[4] as FakeSocket;
    good.serverOpens();
    good.serverSends(frame((e) => syncProtocol.writeSyncStep2(e, new Y.Doc())));
    good.serverCloses();
    world.timers.fireNext();
    for (let i = 5; i < 9; i += 1) {
      await world.socketSignal.waitFor(i + 1);
      (world.sockets[i] as FakeSocket).serverCloses();
      world.timers.fireNext();
    }
    expect(world.statuses.items).not.toContain('unreachable');
    handle.destroy();
  });
});

describe('storage_failed is sticky', () => {
  async function storageFailedWorld(): Promise<ReturnType<typeof connect>> {
    world = await createWorld({}, (real) => ({ ...real, query: () => Promise.reject(new Error('read failed')) }));
    const handle = connect(world);
    await world.statuses.waitFor(1);
    expect(world.statuses.items).toEqual(['storage_failed']);
    return handle;
  }

  it('keeps reporting it through offline, online and lock events until the connection is destroyed', async () => {
    const handle = await storageFailedWorld();
    world.emitOnline(false);
    world.emitOnline(true);
    world.locked = true;
    world.connector.onLockChange();
    await settle();
    world.locked = false;
    world.connector.onLockChange();
    await settle();
    expect(world.statuses.items.length).toBeGreaterThan(1);
    expect(new Set(world.statuses.items)).toEqual(new Set(['storage_failed']));
    handle.destroy();
    expect(world.statuses.items.at(-1)).toBe('closed');
  });

  it('control: a healthy connection still reports offline, locked and the rest as they happen', async () => {
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    world.emitOnline(false);
    expect(world.statuses.items.at(-1)).toBe('offline');
    world.locked = true;
    world.connector.onLockChange();
    await vi.waitFor(() => {
      expect(world.statuses.items.at(-1)).toBe('locked');
    });
    expect(world.statuses.items).not.toContain('storage_failed');
    handle.destroy();
  });
});

describe('an exception from a document observer is not a corrupt frame', () => {
  async function openWithObserver(throws: boolean): Promise<{ handle: ReturnType<typeof connect>; socket: FakeSocket }> {
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    handle.doc.getMap<unknown>('m').observe(() => {
      if (throws) throw new Error('observer boom with secret-detail');
    });
    return { handle, socket };
  }

  function remoteStep2(): Uint8Array {
    const remote = new Y.Doc();
    remote.getMap<unknown>('m').set('k', 'v');
    return frame((e) => syncProtocol.writeSyncStep2(e, remote));
  }

  it('keeps the socket, still turns synced, resets the backoff and reports one generic error', async () => {
    const { handle, socket } = await openWithObserver(true);
    expect(() => socket.serverSends(remoteStep2())).not.toThrow();
    expect(socket.closed).toBe(false);
    expect(handle.doc.getMap<unknown>('m').get('k')).toBe('v');
    expect(handle.synced()).toBe(true);
    expect(world.statuses.items.at(-1)).toBe('synced');
    expect(world.timers.pending()).toBe(0);
    expect(world.errors).toHaveLength(1);
    expect((world.errors[0] as Error).message).toBe('A collaboration update handler failed');

    socket.serverCloses();
    expect(world.timers.requested()).toEqual([400]);
    handle.destroy();
  });

  it('does not loop: a second throwing update is one more report and still no reconnect', async () => {
    const { handle, socket } = await openWithObserver(true);
    socket.serverSends(remoteStep2());
    const more = new Y.Doc();
    more.getMap<unknown>('m').set('k2', 'v2');
    socket.serverSends(frame((e) => syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(more))));
    expect(world.errors).toHaveLength(2);
    expect(socket.closed).toBe(false);
    expect(world.sockets).toHaveLength(1);
    expect(world.timers.pending()).toBe(0);
    handle.destroy();
  });

  it('control: a healthy observer reports nothing', async () => {
    const { handle, socket } = await openWithObserver(false);
    socket.serverSends(remoteStep2());
    expect(world.errors).toEqual([]);
    expect(handle.synced()).toBe(true);
    handle.destroy();
  });
});

describe('a version restore: frames that arrive while it is in progress', () => {
  async function heldRestoreWorld(failReadsAfterClear = false): Promise<{ deleting: Signals<() => void> }> {
    const deleting = new Signals<() => void>();
    let failReads = false;
    world = await createWorld({}, (real) => ({
      ...real,
      query: (sql, params) => (failReads ? Promise.reject(new Error('read failed')) : real.query(sql, params)),
      run: async (sql, params) => {
        if (sql.startsWith('DELETE FROM ydoc_updates')) {
          if (failReadsAfterClear) failReads = true;
          await new Promise<void>((resolve) => {
            deleting.push(resolve);
          });
        }
        return real.run(sql, params);
      },
    }));
    return { deleting };
  }

  it('answers a server step 1 from the restored document, never from the one being thrown away', async () => {
    const { deleting } = await heldRestoreWorld();
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    handle.doc.getMap<unknown>('m').set('stale', 1);
    const changesBefore = world.changes.items.length;

    socket.serverSends(Uint8Array.from([MSG_RESTORE]));
    await deleting.waitFor(1);
    socket.serverSends(frame((e) => syncProtocol.writeSyncStep1(e, new Y.Doc())));
    expect(socket.sent.filter((m) => messageKind(m) === syncProtocol.messageYjsSyncStep2)).toHaveLength(0);

    (deleting.items[0] as () => void)();
    await world.changes.waitFor(changesBefore + 1);
    const replies = socket.sent.filter((m) => messageKind(m) === syncProtocol.messageYjsSyncStep2);
    expect(replies).toHaveLength(1);
    const check = new Y.Doc();
    const decoder = decoding.createDecoder(replies[0] as Uint8Array);
    decoding.readVarUint(decoder);
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), check, null);
    expect(check.getMap<unknown>('m').get('stale')).toBeUndefined();
    handle.destroy();
  }, 1000);

  it('processes the queued frames in their order after the swap', async () => {
    const { deleting } = await heldRestoreWorld();
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    const changesBefore = world.changes.items.length;
    socket.serverSends(Uint8Array.from([MSG_RESTORE]));
    await deleting.waitFor(1);
    const restored = new Y.Doc();
    restored.getMap<unknown>('m').set('restored', true);
    socket.serverSends(frame((e) => syncProtocol.writeSyncStep2(e, restored)));
    expect(handle.synced()).toBe(false);
    (deleting.items[0] as () => void)();
    await world.changes.waitFor(changesBefore + 1);
    expect(handle.doc.getMap<unknown>('m').get('restored')).toBe(true);
    expect(handle.synced()).toBe(true);
    handle.destroy();
  }, 1000);

  it('a replacement document whose stored state cannot be read keeps reporting storage_failed', async () => {
    const { deleting } = await heldRestoreWorld(true);
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    const changesBefore = world.changes.items.length;
    socket.serverSends(Uint8Array.from([MSG_RESTORE]));
    await deleting.waitFor(1);
    (deleting.items[0] as () => void)();
    await world.changes.waitFor(changesBefore + 1);
    await vi.waitFor(() => {
      expect(world.statuses.items.at(-1)).toBe('storage_failed');
    });
    socket.serverSends(frame((e) => syncProtocol.writeSyncStep2(e, new Y.Doc())));
    expect(world.statuses.items.at(-1)).toBe('storage_failed');
    handle.destroy();
  }, 1000);

  it('a malformed frame that arrives during the restore schedules no reconnect until the restore is done', async () => {
    const { deleting } = await heldRestoreWorld();
    const handle = connect(world);
    await handle.persistenceSynced;
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    const changesBefore = world.changes.items.length;
    socket.serverSends(Uint8Array.from([MSG_RESTORE]));
    await deleting.waitFor(1);
    socket.serverSends(Uint8Array.from([0x80]));
    expect(world.timers.pending()).toBe(0);
    (deleting.items[0] as () => void)();
    await world.changes.waitFor(changesBefore + 1);
    expect(world.timers.pending()).toBe(1);
    expect(world.errors).toHaveLength(1);
    handle.destroy();
  }, 1000);
});

describe('consumer callbacks never decide what the connection does', () => {
  it('a throwing onChange after the stored state is applied still starts the first attempt, and is reported generically', async () => {
    const handle = world.connector.connect('insp-1', {
      onChange: () => {
        throw new Error('consumer boom with secret-detail');
      },
    });
    await world.socketSignal.waitFor(1);
    expect(world.errors).toHaveLength(1);
    expect((world.errors[0] as Error).message).toBe('A collaboration callback failed');
    handle.destroy();
  });

  it('a throwing onSynced does not drop the socket or keep the status from turning synced', async () => {
    const handle = world.connector.connect('insp-1', {
      onSynced: () => {
        throw new Error('consumer boom');
      },
    });
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();
    socket.serverSends(frame((e) => syncProtocol.writeSyncStep2(e, new Y.Doc())));
    expect(socket.closed).toBe(false);
    expect(handle.synced()).toBe(true);
    expect(world.statuses.items.at(-1)).toBe('synced');
    expect(world.errors).toHaveLength(1);
    handle.destroy();
  });
});

describe('only the latest lock evaluation counts', () => {
  it('a stale "locked" answer that resolves after the unlock evaluation does not halt the connection', async () => {
    const answers: ((locked: boolean) => void)[] = [];
    let script: (() => boolean | Promise<boolean>)[] = [];
    world = await createWorld({
      isLocked: () => {
        const next = script.shift();
        return next ? next() : false;
      },
    });
    const handle = connect(world);
    await world.socketSignal.waitFor(1);
    const socket = world.sockets[0] as FakeSocket;
    socket.serverOpens();

    script = [
      () =>
        new Promise<boolean>((resolve) => {
          answers.push(resolve);
        }),
      () => false,
    ];
    world.connector.onLockChange();
    world.connector.onLockChange();
    await settle();
    expect(answers).toHaveLength(1);
    (answers[0] as (locked: boolean) => void)(true);
    await settle();
    expect(socket.closed).toBe(false);
    expect(world.statuses.items).not.toContain('locked');
    handle.destroy();
  });
});
