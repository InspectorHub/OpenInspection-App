import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Http, HttpResponse } from '../auth/http';
import type { SessionCheck, TokenManager } from '../auth/tokens';
import { readSyncMarker } from '../offline/sync-marker';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import type { Network } from '../platform/network';
import { migrate } from '../platform/schema';
import { createCollabConnector, resultsDocName, type CollabConnectorDeps, type CollabSocket, type CollabStatus, type SocketHandlers } from './connector';
import { deleteSetKey, docIsCovered } from './sync-proof';
import { createManualTimers } from './test-support/manual-timers';
import { neverBlocked } from '../test-support/never-blocked';

const ORIGIN = 'https://oi.example.test';
const MSG_SYNC = 0;
const MSG_RESTORE = 2;
const DOC = resultsDocName('insp-1');

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

function frame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function kindOf(data: Uint8Array): number {
  const decoder = decoding.createDecoder(data);
  decoding.readVarUint(decoder);
  return decoding.readVarUint(decoder);
}

const ticketReply = (n: number): HttpResponse => {
  const json = { success: true, data: { ticket: `ticket-number-${String(n).padStart(4, '0')}-abcdef`, expiresIn: 60 } };
  return { status: 200, headers: new Headers(), text: JSON.stringify(json), json, retryAfterMs: null, upgrade: null, serverDateMs: null };
};

interface World {
  db: Db;
  sockets: FakeSocket[];
  errors: unknown[];
  proofErrors: unknown[];
  statuses: CollabStatus[];
  connector: ReturnType<typeof createCollabConnector>;
}

async function createWorld(wrap?: (db: Db) => Db, overrides: Partial<CollabConnectorDeps> = {}): Promise<World> {
  const real = await createSqlJsDb();
  await migrate(real, 0);
  const db = wrap ? wrap(real) : real;
  const sockets: FakeSocket[] = [];
  const world: World = { db: real, sockets, errors: [], proofErrors: [], statuses: [], connector: undefined as never };
  let n = 0;
  const http: Http = { request: () => Promise.resolve(ticketReply((n += 1))) };
  const network: Network = { online: () => Promise.resolve(true), onChange: () => () => undefined };
  const tokens = {
    getAccessToken: vi.fn(() => Promise.resolve<string | null>('access-token-1')),
    checkSession: vi.fn(() => Promise.resolve<SessionCheck>({ kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } })),
  };
  world.connector = createCollabConnector({
    isBlocked: neverBlocked,
    db,
    http,
    tokens: tokens as unknown as Pick<TokenManager, 'getAccessToken' | 'checkSession'>,
    network,
    origin: ORIGIN,
    isLocked: () => false,
    openSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
    timers: createManualTimers(),
    random: () => 1,
    onError: (error) => world.errors.push(error),
    onProofError: (error) => world.proofErrors.push(error),
    onStatus: (_id, status) => world.statuses.push(status),
    ...overrides,
  });
  return world;
}

async function barrier(db: Db): Promise<void> {
  await db.query('SELECT 1');
}

async function openSocket(world: World, id = 'insp-1'): Promise<{ handle: ReturnType<World['connector']['connect']>; socket: FakeSocket }> {
  const before = world.sockets.length;
  const handle = world.connector.connect(id, {});
  await handle.persistenceSynced;
  await vi.waitFor(() => {
    expect(world.sockets.length).toBeGreaterThan(before);
  });
  const socket = world.sockets[world.sockets.length - 1] as FakeSocket;
  socket.serverOpens();
  return { handle, socket };
}

/** A server that holds the given documents' content. */
function server(...contents: Y.Doc[]): Y.Doc {
  const doc = new Y.Doc();
  for (const content of contents) Y.applyUpdate(doc, Y.encodeStateAsUpdate(content));
  return doc;
}

const serverStep1 = (doc: Y.Doc): Uint8Array => frame((e) => syncProtocol.writeSyncStep1(e, doc));
const serverStep2 = (doc: Y.Doc, clientStateVector: Uint8Array): Uint8Array => frame((e) => syncProtocol.writeSyncStep2(e, doc, clientStateVector));

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

describe('the sync proof is written only from what the server said', () => {
  it('writes nothing when the socket opens, when this device sends its own step 1, and when it sends an update', async () => {
    const { handle, socket } = await openSocket(world);
    handle.doc.getMap<unknown>('m').set('local', 1);
    await barrier(world.db);
    expect(socket.sent.some((m) => kindOf(m) === syncProtocol.messageYjsSyncStep1)).toBe(true);
    expect(socket.sent.some((m) => kindOf(m) === syncProtocol.messageYjsUpdate)).toBe(true);
    expect(await world.db.query('SELECT * FROM ydoc_sync')).toEqual([]);
    handle.destroy();
  });

  it('answers a server step 1 with its own step 2 and records only the server state vector the step 1 carried', async () => {
    const { handle, socket } = await openSocket(world);
    handle.doc.getMap<unknown>('m').set('local', 1);
    const remote = server();
    socket.serverSends(serverStep1(remote));
    await barrier(world.db);
    expect(socket.sent.some((m) => kindOf(m) === syncProtocol.messageYjsSyncStep2)).toBe(true);
    const marker = await readSyncMarker(world.db, DOC);
    expect([...(marker?.coveredState ?? [])]).toEqual([...Y.encodeStateVector(remote)]);
    expect(await readSyncMarker(world.db, deleteSetKey(DOC))).toBeNull();
    handle.destroy();
  });

  it('records the server state vector of step 1 exactly, and the deleted ranges of step 2', async () => {
    const { handle, socket } = await openSocket(world);
    const remote = new Y.Doc();
    remote.getMap<unknown>('m').set('theirs', 1);
    remote.getMap<unknown>('m').set('theirs', 2);
    socket.serverSends(serverStep1(remote));
    socket.serverSends(serverStep2(remote, Y.encodeStateVector(handle.doc)));
    await barrier(world.db);
    const marker = await readSyncMarker(world.db, DOC);
    expect([...(marker?.coveredState ?? [])]).toEqual([...Y.encodeStateVector(remote)]);
    expect(await readSyncMarker(world.db, deleteSetKey(DOC))).not.toBeNull();
    handle.destroy();
  });

  it('every proof row written during a whole handshake is a server observation, byte for byte', async () => {
    const written: Uint8Array[] = [];
    const spy = (inner: Db): Db => ({
      ...inner,
      run: (sql, params) => {
        if (sql.includes('INSERT INTO ydoc_sync')) written.push(params?.[1] as Uint8Array);
        return inner.run(sql, params);
      },
      transaction: (fn) => inner.transaction((tx) => fn(spy(tx))),
    });
    world = await createWorld(spy);
    const { handle, socket } = await openSocket(world);
    handle.doc.getMap<unknown>('m').set('local', 1);
    const remote = new Y.Doc();
    remote.getMap<unknown>('m').set('theirs', 1);
    socket.serverSends(serverStep1(remote));
    socket.serverSends(serverStep2(remote, Y.encodeStateVector(handle.doc)));
    await barrier(world.db);
    expect(written).toHaveLength(2);
    const texts = written.map((bytes) => [...bytes].join(','));
    expect(texts).toContain([...Y.encodeStateVector(remote)].join(','));
    expect(texts).not.toContain([...Y.encodeStateVector(handle.doc)].join(','));
    handle.destroy();
  });

  it('a step 2 or an update alone does not write a state vector marker', async () => {
    const { handle, socket } = await openSocket(world);
    const remote = new Y.Doc();
    remote.getMap<unknown>('m').set('theirs', 1);
    socket.serverSends(serverStep2(remote, Y.encodeStateVector(handle.doc)));
    socket.serverSends(frame((e) => syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(remote))));
    await barrier(world.db);
    expect(await readSyncMarker(world.db, DOC)).toBeNull();
    handle.destroy();
  });

  it('a step 1 that is not a state vector is a frame that cannot be read: nothing is recorded', async () => {
    const { handle, socket } = await openSocket(world);
    const broken = frame((e) => {
      encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep1);
      encoding.writeVarUint8Array(e, Uint8Array.from([255]));
    });
    socket.serverSends(broken);
    await barrier(world.db);
    expect(await readSyncMarker(world.db, DOC)).toBeNull();
    expect(world.errors).toHaveLength(1);
    handle.destroy();
  });
});

describe('what the proof says about an offline edit', () => {
  /** The device edits offline, connects, and exchanges the handshake with a server that did not have the edit. */
  async function editOfflineThenHandshake(): Promise<{ edited: Y.Doc; remote: Y.Doc; handle: Awaited<ReturnType<typeof openSocket>>['handle']; socket: FakeSocket }> {
    const first = await openSocket(world);
    first.handle.doc.getMap<unknown>('m').set('offline', 'edit');
    await barrier(world.db);
    first.socket.serverCloses();
    first.handle.destroy();
    await first.handle.persistenceSynced;
    const second = await openSocket(world);
    const remote = new Y.Doc();
    second.socket.serverSends(serverStep1(remote));
    second.socket.serverSends(serverStep2(remote, Y.encodeStateVector(second.handle.doc)));
    await barrier(world.db);
    return { edited: second.handle.doc, remote, handle: second.handle, socket: second.socket };
  }

  it('is not covered when the connection was dropped after one handshake: the server state vector was taken before it received the edit', async () => {
    const { handle, socket } = await editOfflineThenHandshake();
    expect(socket.sent.some((m) => kindOf(m) === syncProtocol.messageYjsSyncStep2)).toBe(true);
    expect(await docIsCovered(world.db, DOC)).toBe(false);
    handle.destroy();
  });

  it('control: covered after a later handshake in which the server already holds the edit', async () => {
    const { edited, handle, socket } = await editOfflineThenHandshake();
    expect(await docIsCovered(world.db, DOC)).toBe(false);
    socket.serverCloses();
    handle.destroy();
    await handle.persistenceSynced;
    const third = await openSocket(world);
    const remote = server(edited);
    third.socket.serverSends(serverStep1(remote));
    third.socket.serverSends(serverStep2(remote, Y.encodeStateVector(third.handle.doc)));
    await barrier(world.db);
    expect(await docIsCovered(world.db, DOC)).toBe(true);
    third.handle.destroy();
  });
});

describe('a failing proof write never breaks the sync', () => {
  it('keeps the document syncing, reports one generic proof error and no storage error', async () => {
    const failing = (inner: Db): Db => ({
      ...inner,
      run: (sql, params) => (sql.includes('ydoc_sync') ? Promise.reject(new Error('disk full')) : inner.run(sql, params)),
      transaction: (fn) => inner.transaction((tx) => fn(failing(tx))),
    });
    world = await createWorld(failing);
    const { handle, socket } = await openSocket(world);
    const remote = new Y.Doc();
    remote.getMap<unknown>('m').set('theirs', 1);
    socket.serverSends(serverStep1(remote));
    socket.serverSends(serverStep2(remote, Y.encodeStateVector(handle.doc)));
    await vi.waitFor(() => {
      expect(world.proofErrors.length).toBeGreaterThan(0);
    });
    expect(handle.synced()).toBe(true);
    expect(handle.doc.getMap<unknown>('m').get('theirs')).toBe(1);
    expect(world.errors).toEqual([]);
    expect(world.statuses).toContain('synced');
    expect(socket.closed).toBe(false);
    expect(String(world.proofErrors[0])).not.toContain('disk full');
    handle.destroy();
  });

  it('control: the same handshake on a healthy database records the proof and reports nothing', async () => {
    const { handle, socket } = await openSocket(world);
    const remote = new Y.Doc();
    remote.getMap<unknown>('m').set('theirs', 1);
    socket.serverSends(serverStep1(remote));
    socket.serverSends(serverStep2(remote, Y.encodeStateVector(handle.doc)));
    await barrier(world.db);
    expect(world.proofErrors).toEqual([]);
    expect(await readSyncMarker(world.db, DOC)).not.toBeNull();
    handle.destroy();
  });
});

describe('the proof follows the stored document', () => {
  async function withProofRows(id: string): Promise<void> {
    const doc = resultsDocName(id);
    await world.db.run('INSERT INTO ydoc_sync (doc_name, covered_state, updated_at) VALUES (?, ?, 1)', [doc, Y.encodeStateVector(new Y.Doc())]);
    await world.db.run('INSERT INTO ydoc_sync (doc_name, covered_state, updated_at) VALUES (?, ?, 1)', [deleteSetKey(doc), Uint8Array.from([0])]);
  }

  it('a version restore drops the proof of that document together with its rows', async () => {
    const { handle, socket } = await openSocket(world);
    await withProofRows('insp-1');
    await withProofRows('insp-2');
    socket.serverSends(Uint8Array.from([MSG_RESTORE]));
    await vi.waitFor(async () => {
      expect(await readSyncMarker(world.db, DOC)).toBeNull();
    });
    expect(await readSyncMarker(world.db, deleteSetKey(DOC))).toBeNull();
    expect(await readSyncMarker(world.db, resultsDocName('insp-2'))).not.toBeNull();
    handle.destroy();
  });

  it('purge drops the proof of that inspection and leaves the others alone', async () => {
    await withProofRows('insp-1');
    await withProofRows('insp-2');
    await world.connector.purge('insp-1');
    expect(await readSyncMarker(world.db, DOC)).toBeNull();
    expect(await readSyncMarker(world.db, deleteSetKey(DOC))).toBeNull();
    expect(await readSyncMarker(world.db, resultsDocName('insp-2'))).not.toBeNull();
    expect(await readSyncMarker(world.db, deleteSetKey(resultsDocName('insp-2')))).not.toBeNull();
  });

  it('a purge whose proof cannot be cleared rejects and leaves the document rows in place: rows and proof go together or not at all', async () => {
    const failing = (inner: Db): Db => ({
      ...inner,
      run: (sql, params) => (sql.includes('DELETE FROM ydoc_sync') ? Promise.reject(new Error('disk full')) : inner.run(sql, params)),
      transaction: (fn) => inner.transaction((tx) => fn(failing(tx))),
    });
    world = await createWorld(failing);
    await withProofRows('insp-1');
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [DOC, Y.encodeStateAsUpdate(new Y.Doc())]);
    await expect(world.connector.purge('insp-1')).rejects.toThrow();
    expect(await world.db.query('SELECT id FROM ydoc_updates WHERE doc_name = ?', [DOC])).toHaveLength(1);
    expect(await readSyncMarker(world.db, DOC)).not.toBeNull();
  });

  it('control: the same purge on a healthy database removes the rows and the proof', async () => {
    await withProofRows('insp-1');
    await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [DOC, Y.encodeStateAsUpdate(new Y.Doc())]);
    await world.connector.purge('insp-1');
    expect(await world.db.query('SELECT id FROM ydoc_updates WHERE doc_name = ?', [DOC])).toEqual([]);
    expect(await readSyncMarker(world.db, DOC)).toBeNull();
  });

  it('a restore whose proof cannot be cleared is reported, and the stale marker never makes the new document look covered until the next step 1', async () => {
    let failNext = true;
    const failingOnce = (inner: Db): Db => ({
      ...inner,
      run: (sql, params) => {
        if (failNext && sql.includes('DELETE FROM ydoc_sync')) {
          failNext = false;
          return Promise.reject(new Error('disk full'));
        }
        return inner.run(sql, params);
      },
      transaction: (fn) => inner.transaction((tx) => fn(failingOnce(tx))),
    });
    world = await createWorld(failingOnce);
    const { handle, socket } = await openSocket(world);
    await withProofRows('insp-1');
    const step1sBefore = socket.sent.filter((m) => kindOf(m) === syncProtocol.messageYjsSyncStep1).length;
    socket.serverSends(Uint8Array.from([MSG_RESTORE]));
    await vi.waitFor(() => {
      expect(world.proofErrors).toHaveLength(1);
      expect(socket.sent.filter((m) => kindOf(m) === syncProtocol.messageYjsSyncStep1).length).toBeGreaterThan(step1sBefore);
    });
    expect(await readSyncMarker(world.db, DOC)).not.toBeNull();

    handle.doc.getMap<unknown>('m').set('after', 1);
    await vi.waitFor(async () => {
      expect(await world.db.query('SELECT id FROM ydoc_updates WHERE doc_name = ?', [DOC])).not.toHaveLength(0);
    });
    expect(await docIsCovered(world.db, DOC)).toBe(false);

    const remote = server(handle.doc);
    socket.serverSends(serverStep1(remote));
    await vi.waitFor(async () => {
      expect(await docIsCovered(world.db, DOC)).toBe(true);
    });
    expect([...((await readSyncMarker(world.db, DOC))?.coveredState ?? [])]).toEqual([...Y.encodeStateVector(remote)]);
    handle.destroy();
  });

  it('control: opening and closing a connection on its own leaves the proof rows in place', async () => {
    await withProofRows('insp-1');
    const { handle } = await openSocket(world);
    handle.destroy();
    await handle.persistenceSynced;
    await barrier(world.db);
    expect(await readSyncMarker(world.db, DOC)).not.toBeNull();
  });
});
