import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Http, HttpResponse } from '../auth/http';
import type { SessionCheck, TokenManager } from '../auth/tokens';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import type { Network } from '../platform/network';
import { migrate } from '../platform/schema';
import { CollabBlockedError, createCollabConnector, type CollabSocket, type CollabStatus, type SocketHandlers } from './connector';
import { createManualTimers, type ManualTimers } from './test-support/manual-timers';

const ORIGIN = 'https://oi.example.test';

class FakeSocket implements CollabSocket {
  closed = false;
  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {}
  isOpen(): boolean {
    return !this.closed;
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
}

function ticketReply(n: number): HttpResponse {
  const json = { success: true, data: { ticket: `ticket-number-${String(n).padStart(4, '0')}-abcdef`, expiresIn: 60 } };
  return { status: 200, headers: new Headers(), text: JSON.stringify(json), json, retryAfterMs: null, upgrade: null, serverDateMs: null };
}

interface World {
  db: Db;
  requests: string[];
  sockets: FakeSocket[];
  statuses: { id: string; status: CollabStatus }[];
  reads: string[];
  timers: ManualTimers;
  connector: ReturnType<typeof createCollabConnector>;
}

async function createWorld(isBlocked?: (id: string) => Promise<boolean>): Promise<World> {
  const real = await createSqlJsDb();
  await migrate(real, 0);
  const reads: string[] = [];
  const db: Db = { ...real, query: (sql, params) => (reads.push(sql), real.query(sql, params)) };
  const timers = createManualTimers();
  const requests: string[] = [];
  const sockets: FakeSocket[] = [];
  const statuses: World['statuses'] = [];
  let tickets = 0;
  const http: Http = {
    request: (req) => {
      requests.push(req.url);
      tickets += 1;
      return Promise.resolve(ticketReply(tickets));
    },
  };
  const network: Network = { online: () => Promise.resolve(true), onChange: () => () => undefined };
  const tokens = {
    getAccessToken: vi.fn(() => Promise.resolve<string | null>('access-token-1')),
    checkSession: vi.fn(() => Promise.resolve<SessionCheck>({ kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } })),
  } as unknown as Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  const connector = createCollabConnector({
    db,
    http,
    tokens,
    network,
    origin: ORIGIN,
    isLocked: () => false,
    openSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
    timers,
    random: () => 1,
    onError: () => undefined,
    onStatus: (id, status) => statuses.push({ id, status }),
    ...(isBlocked === undefined ? {} : { isBlocked }),
  });
  return { db: real, requests, sockets, statuses, reads, timers, connector };
}

const docRows = async (db: Db, id: string): Promise<number> => Number((await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [`results-${id}`]))[0]?.n);

describe('connect refuses a blocked inspection', () => {
  it('rejects persistenceSynced with a typed blocked error, opens no ticket request and no socket, and reads no document rows', async () => {
    const world = await createWorld(() => Promise.resolve(true));
    const handle = world.connector.connect('insp-1', {});
    await expect(handle.persistenceSynced).rejects.toBeInstanceOf(CollabBlockedError);
    await expect(handle.persistenceSynced).rejects.toMatchObject({ code: 'blocked' });
    expect(world.requests).toEqual([]);
    expect(world.sockets).toEqual([]);
    expect(world.reads.filter((sql) => sql.includes('ydoc_updates'))).toEqual([]);
    expect(world.statuses.map((s) => s.status)).toContain('blocked');
    expect(world.connector.isOpen('insp-1')).toBe(false);
  });

  it('control: the same call with a guard that says free connects and opens the socket', async () => {
    const world = await createWorld(() => Promise.resolve(false));
    const handle = world.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    await vi.waitFor(() => {
      expect(world.sockets).toHaveLength(1);
    });
    expect(world.statuses.map((s) => s.status)).not.toContain('blocked');
    handle.destroy();
  });

  it('fails closed: a guard that throws blocks', async () => {
    const world = await createWorld(() => Promise.reject(new Error('unreadable')));
    const handle = world.connector.connect('insp-1', {});
    await expect(handle.persistenceSynced).rejects.toBeInstanceOf(CollabBlockedError);
    expect(world.requests).toEqual([]);
  });

  it('a blocked handle never stores an edit made on its document', async () => {
    const world = await createWorld(() => Promise.resolve(true));
    const handle = world.connector.connect('insp-1', {});
    await handle.persistenceSynced.catch(() => undefined);
    handle.doc.getMap<unknown>('m').set('k', 'typed after the block');
    await world.db.query('SELECT 1');
    expect(await docRows(world.db, 'insp-1')).toBe(0);
  });

  it('a control without a guard dependency still connects (the guard is optional for this module)', async () => {
    const world = await createWorld();
    const handle = world.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    await vi.waitFor(() => {
      expect(world.sockets).toHaveLength(1);
    });
    handle.destroy();
  });

  it('asks the guard once per connect and only for the inspection being connected', async () => {
    const asked: string[] = [];
    const world = await createWorld((id) => {
      asked.push(id);
      return Promise.resolve(id === 'blocked-one');
    });
    const a = world.connector.connect('blocked-one', {});
    const b = world.connector.connect('free-one', {});
    await expect(a.persistenceSynced).rejects.toBeInstanceOf(CollabBlockedError);
    await b.persistenceSynced;
    expect(asked.sort()).toEqual(['blocked-one', 'free-one']);
    b.destroy();
  });
});

describe('a connection that is closed while the guard is still answering', () => {
  it('a purge that ran first leaves no persistence, no ticket request and no document rows behind', async () => {
    let answer: (blocked: boolean) => void = () => undefined;
    const world = await createWorld(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const handle = world.connector.connect('insp-1', {});
    await world.connector.purge('insp-1');
    answer(false);
    await world.db.query('SELECT 1');
    handle.doc.getMap<unknown>('m').set('k', 'late edit');
    await world.db.query('SELECT 1');
    expect(world.requests).toEqual([]);
    expect(world.sockets).toEqual([]);
    expect(await docRows(world.db, 'insp-1')).toBe(0);
    expect(world.connector.isOpen('insp-1')).toBe(false);
  });
});

describe('closeFor', () => {
  it('closes the live connection of one inspection, keeps its stored rows, and leaves the others alone', async () => {
    const world = await createWorld(() => Promise.resolve(false));
    const seed = new Y.Doc();
    seed.getMap<unknown>('m').set('k', 'stored');
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-insp-1', Y.encodeStateAsUpdate(seed)]);
    const a = world.connector.connect('insp-1', {});
    const b = world.connector.connect('insp-2', {});
    await a.persistenceSynced;
    await b.persistenceSynced;
    await vi.waitFor(() => {
      expect(world.sockets).toHaveLength(2);
    });
    await world.connector.closeFor('insp-1');
    expect(world.connector.isOpen('insp-1')).toBe(false);
    expect(world.connector.isOpen('insp-2')).toBe(true);
    expect(world.sockets.map((s) => s.closed)).toEqual([true, false]);
    expect(await docRows(world.db, 'insp-1')).toBe(1);
    b.destroy();
  });

  it('is a no-op for an inspection with no connection, and rejects an id that is not an inspection id', async () => {
    const world = await createWorld();
    await expect(world.connector.closeFor('nothing-here')).resolves.toBeUndefined();
    await expect(world.connector.closeFor('a/b')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('a reconnect for an inspection that became blocked', () => {
  it('stops with the blocked status instead of asking for another ticket', async () => {
    let blocked = false;
    const world = await createWorld(() => Promise.resolve(blocked));
    const handle = world.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    await vi.waitFor(() => {
      expect(world.sockets).toHaveLength(1);
    });
    blocked = true;
    world.sockets[0]?.handlers.close();
    world.timers.fireNext();
    await vi.waitFor(() => {
      expect(world.statuses.map((s) => s.status)).toContain('blocked');
    });
    expect(world.requests).toHaveLength(1);
    expect(world.sockets).toHaveLength(1);
    handle.destroy();
  });

  it('control: the same reconnect while the inspection is free asks for a second ticket', async () => {
    const world = await createWorld(() => Promise.resolve(false));
    const handle = world.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    await vi.waitFor(() => {
      expect(world.sockets).toHaveLength(1);
    });
    world.sockets[0]?.handlers.close();
    world.timers.fireNext();
    await vi.waitFor(() => {
      expect(world.requests).toHaveLength(2);
    });
    expect(world.statuses.map((s) => s.status)).not.toContain('blocked');
    handle.destroy();
  });
});
