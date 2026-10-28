import { vi } from 'vitest';
import { createMemoryFiles, type MemoryFiles } from '../../app/test-support/memory-files';
import type { Http, HttpResponse } from '../../auth/http';
import type { SessionCheck, TokenManager } from '../../auth/tokens';
import { createCollabConnector, type CollabSocket, type NativeCollabConnector, type SocketHandlers } from '../../collab/connector';
import { createManualTimers } from '../../collab/test-support/manual-timers';
import type { Db } from '../../platform/db';
import type { Network } from '../../platform/network';
import { createBlockedGuard } from '../blocked';
import { accountKey } from '../outbox';
import type { PurgeDeps } from '../purge';
import type { ExecuteDeps } from '../reconcile-execute';
import { ALICE, createReconcileWorld, type ReconcileWorld } from './reconcile-world';

export class FakeSocket implements CollabSocket {
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

/** The tables an inspection's data lives in, with the column that names the inspection (or its document). */
export const PER_INSPECTION_TABLES = ['work_package', 'outbox', 'media', 'ydoc_updates', 'ydoc_sync', 'resource_cache', 'item_tags'] as const;
export type InspectionTable = (typeof PER_INSPECTION_TABLES)[number];

export interface PurgeWorld extends ReconcileWorld {
  files: MemoryFiles;
  connector: NativeCollabConnector;
  sockets: FakeSocket[];
  /** The ids the test's editor port reports as open. */
  editorOpen: Set<string>;
  /** Ids `onPurging` was called with, in order. */
  purgingSignals: string[];
  /** Ids `uploader.cancelFor` was called with, in order. */
  cancelled: string[];
  /** Deps for `purgeInspection`, on the real database, real connector and real guard. */
  purgeDeps(overrides?: Partial<PurgeDeps>): PurgeDeps;
  /** Deps for `executeReconcilePlan`: the same, plus the world's clock, account and lock state. */
  executeDeps(overrides?: Partial<ExecuteDeps>): ExecuteDeps;
  /** Ids the quarantine signalled to the editor, and the ids whose block was lifted, in order. */
  quarantineSignals: string[];
  unquarantineSignals: string[];
  /** Everything an inspection owns: all six tables, plus the bytes of its media files. */
  data(id: string): Promise<string>;
  /** Row counts of one inspection per table (cached resources of the signed-in account), and its files. */
  counts(id: string): Promise<Record<InspectionTable | 'files', number>>;
  /** A full seed: package, queued writes, media rows with files, a stored and covered document, cached resources and the error marker. */
  seedFull(id: string, options?: { quarantine?: string | null; unsent?: boolean }): Promise<void>;
  /** The minimum an automatic purge accepts: package, a stored document the server covers, cached resources and the marker. */
  seedPurgeable(id: string): Promise<void>;
  /** A media row whose file exists. */
  mediaFile(id: string, pendingId: string, state?: string): Promise<string>;
  /** Opens a connection to the inspection through the real connector. */
  connect(id: string): ReturnType<NativeCollabConnector['connect']>;
}

export async function createPurgeWorld(): Promise<PurgeWorld> {
  const base = await createReconcileWorld();
  const world = base as PurgeWorld;
  const files = createMemoryFiles();
  const sockets: FakeSocket[] = [];
  let tickets = 0;
  const http: Http = {
    request: () => {
      tickets += 1;
      return Promise.resolve(ticketReply(tickets));
    },
  };
  const network: Network = { online: () => Promise.resolve(true), onChange: () => () => undefined };
  const tokens = {
    getAccessToken: vi.fn(() => Promise.resolve<string | null>('access-token-1')),
    checkSession: vi.fn(() => Promise.resolve<SessionCheck>({ kind: 'ok', session: { userId: 'alice', tenantId: 'tenant-1', role: 'inspector', offlineMaxDays: 7 } })),
  } as unknown as Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  const guard = createBlockedGuard(world.db);
  const connector = createCollabConnector({
    db: world.db,
    http,
    tokens,
    network,
    origin: 'https://oi.example.test',
    isLocked: () => false,
    openSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
    timers: createManualTimers(),
    random: () => 1,
    onError: () => undefined,
    isBlocked: guard,
  });
  const editorOpen = new Set<string>();
  const purgingSignals: string[] = [];
  const cancelled: string[] = [];
  const quarantineSignals: string[] = [];
  const unquarantineSignals: string[] = [];
  let mediaCounter = 0;
  let executeTokens = 0;

  const filePath = (pendingId: string): string => `media/${pendingId}.jpg`;

  const mediaFile = async (id: string, pendingId: string, state = 'pending'): Promise<string> => {
    mediaCounter += 1;
    const path = filePath(pendingId);
    await files.write(path, new Uint8Array([mediaCounter, mediaCounter, mediaCounter]));
    await world.db.run("INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, 'photo', ?, 'image/jpeg', '{}', ?, ?)", [pendingId, id, path, state, mediaCounter]);
    return path;
  };

  const seedPurgeable = async (id: string): Promise<void> => {
    await world.pkg(id);
    const rows = await world.ydoc(id);
    await world.cover(id, rows);
    const key = accountKey(ALICE);
    await world.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, 'e', '{}', 5, ?)", [key, `/api/inspections/${id}`, id]);
    await world.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, 'e', '{}', 5, ?)", [key, `/api/inspections/${id}/results`, id]);
    await world.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, 'network', 5, ?)", [key, `$refresh_error:${id}`, id]);
    // A tag a person put on an item that the server has not been told about yet: a purge must take it too.
    await world.db.run("INSERT INTO item_tags (account_key, inspection_id, item_id, tag_id, name, color, state, updated_at) VALUES (?, ?, 'item-1', 'tag-1', 'Urgent', NULL, 'add', 5)", [key, id]);
  };

  const seedFull = async (id: string, options: { quarantine?: string | null; unsent?: boolean } = {}): Promise<void> => {
    await seedPurgeable(id);
    if (options.quarantine !== undefined && options.quarantine !== null) await world.db.run('UPDATE work_package SET quarantine_source = ? WHERE inspection_id = ?', [options.quarantine, id]);
    if (options.unsent !== false) {
      await mediaFile(id, `${id}-m1`, 'pending');
      await mediaFile(id, `${id}-m2`, 'uploaded');
      await world.outbox(id, 'pending');
      await world.outbox(id, 'failed');
    }
  };

  const data = async (id: string): Promise<string> => {
    const parts: string[] = [];
    const dump = (rows: unknown[]): string => JSON.stringify(rows, (_k, v: unknown) => (v instanceof Uint8Array ? `bytes:${Array.from(v).join(',')}` : v));
    parts.push(dump(await world.db.query('SELECT * FROM work_package WHERE inspection_id = ? ORDER BY rowid', [id])));
    parts.push(dump(await world.db.query('SELECT * FROM outbox WHERE inspection_id = ? ORDER BY rowid', [id])));
    const media = await world.db.query<{ path: string }>('SELECT * FROM media WHERE inspection_id = ? ORDER BY rowid', [id]);
    parts.push(dump(media));
    for (const row of media) parts.push(`${row.path}=${Array.from(files.bytes(row.path) ?? []).join(',')}`);
    parts.push(dump(await world.db.query('SELECT * FROM ydoc_updates WHERE doc_name = ? ORDER BY id', [`results-${id}`])));
    parts.push(dump(await world.db.query('SELECT * FROM ydoc_sync WHERE doc_name IN (?, ?) ORDER BY doc_name', [`results-${id}`, `ds:results-${id}`])));
    parts.push(dump(await world.db.query('SELECT * FROM resource_cache WHERE package_id = ? ORDER BY key', [id])));
    parts.push(dump(await world.db.query('SELECT * FROM item_tags WHERE inspection_id = ? ORDER BY item_id, tag_id', [id])));
    return parts.join('|');
  };

  const counts = async (id: string): Promise<Record<InspectionTable | 'files', number>> => {
    const n = async (sql: string, params: unknown[]): Promise<number> => Number((await world.db.query<{ n: number }>(sql, params))[0]?.n);
    const media = await world.db.query<{ path: string }>('SELECT path FROM media WHERE inspection_id = ?', [id]);
    const present = files.paths().filter((path) => media.some((row) => row.path === path)).length;
    return {
      work_package: await n('SELECT COUNT(*) AS n FROM work_package WHERE inspection_id = ?', [id]),
      outbox: await n('SELECT COUNT(*) AS n FROM outbox WHERE inspection_id = ?', [id]),
      media: media.length,
      ydoc_updates: await n('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [`results-${id}`]),
      ydoc_sync: await n('SELECT COUNT(*) AS n FROM ydoc_sync WHERE doc_name IN (?, ?)', [`results-${id}`, `ds:results-${id}`]),
      resource_cache: await n('SELECT COUNT(*) AS n FROM resource_cache WHERE package_id = ? AND account_key = ?', [id, accountKey(ALICE)]),
      item_tags: await n('SELECT COUNT(*) AS n FROM item_tags WHERE inspection_id = ? AND account_key = ?', [id, accountKey(ALICE)]),
      files: present,
    };
  };

  Object.assign(world, {
    files,
    connector,
    sockets,
    editorOpen,
    purgingSignals,
    cancelled,
    quarantineSignals,
    unquarantineSignals,
    mediaFile,
    seedPurgeable,
    seedFull,
    data,
    counts,
    connect: (id: string) => connector.connect(id, {}),
    purgeDeps: (overrides: Partial<PurgeDeps> = {}): PurgeDeps => ({
      db: world.db as Db,
      files,
      connector,
      isBlocked: guard,
      isOpenInEditor: (id) => editorOpen.has(id),
      onPurging: (id) => {
        purgingSignals.push(id);
      },
      uploader: {
        cancelFor: (id) => {
          cancelled.push(id);
          return Promise.resolve();
        },
      },
      ...overrides,
    }),
    executeDeps: (overrides: Partial<ExecuteDeps> = {}): ExecuteDeps => {
      const { checkpoint: _checkpoint, ...purge } = world.purgeDeps();
      void _checkpoint;
      return {
        ...purge,
        connector,
        clock: world.clock,
        account: () => world.state.account,
        isLocked: () => {
          if (world.state.lockedThrows) throw new Error('lock state unreadable');
          return world.state.locked;
        },
        newToken: () => `execute-holder-${String((executeTokens += 1))}`,
        onQuarantined: (id) => {
          quarantineSignals.push(id);
        },
        onUnquarantined: (id) => {
          unquarantineSignals.push(id);
        },
        ...overrides,
      };
    },
  });
  return world;
}

/** Every file path still stored, sorted. */
export function allFiles(world: PurgeWorld): string[] {
  return world.files.paths().sort();
}
