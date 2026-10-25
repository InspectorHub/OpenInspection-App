import { unzipSync, type Unzipped } from 'fflate';
import * as Y from 'yjs';
import { saveIdentity } from '../../auth/server-config';
import { createManualClock, type ManualClock } from '../../platform/clock';
import type { Db } from '../../platform/db';
import { createSqlJsDb } from '../../platform/db-sqljs';
import type { FileEntry } from '../../platform/files';
import { migrate } from '../../platform/schema';
import type { Account } from '../../offline/outbox';
import type { ExportFilesPort } from '../exporter';
import type { Sharer } from '../share-package';

export const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
export const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };
export const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

/** Strings that must never reach a package: they stand for what the secure store and the sign-in flow keep. */
export const SECRETS = ['ACCESS-TOKEN-FIXTURE', 'REFRESH-TOKEN-FIXTURE', 'CLIENT-ID-FIXTURE', 'DEVICE-KEY-FIXTURE'] as const;

export interface ExportFiles extends ExportFilesPort {
  /** Puts a media file in the app storage. */
  put(path: string, bytes: Uint8Array): void;
  /** Makes `read` produce this many bytes of generated data for the path, without storing them. */
  generate(path: string, size: number): void;
  /** Files currently in the cache directory, by name. */
  cacheNames(): string[];
  cacheBytes(name: string): Uint8Array | undefined;
  /** Puts a file in the cache the way an earlier run or another component would have left it. */
  seedCache(name: string, bytes?: Uint8Array): void;
  /** Total bytes handed to the cache writer so far. */
  writtenBytes(): number;
  /** Total bytes `read` produced so far. */
  readBytes(): number;
  /** Every `read` call as [path, bytes already written to the cache at that moment, bytes read before it]. */
  reads(): { path: string; writtenAtRead: number; readBefore: number }[];
  /** Most `read` calls that were open at the same moment. */
  maxConcurrentReads(): number;
  /** Paths `removeCache` was asked for. */
  removeCalls(): string[];
  failRemoveCache(): void;
  failWriteAfter(bytes: number): void;
  failReadFor(path: string): void;
  retain(keep: boolean): void;
}

export function createExportFiles(): ExportFiles {
  const media = new Map<string, Uint8Array>();
  const generated = new Map<string, number>();
  const cache = new Map<string, Uint8Array>();
  const failingReads = new Set<string>();
  const readLog: { path: string; writtenAtRead: number; readBefore: number }[] = [];
  const removed: string[] = [];
  let written = 0;
  let readTotal = 0;
  let open = 0;
  let maxOpen = 0;
  let removeFails = false;
  let failAfter: number | null = null;
  let keep = true;

  return {
    put: (path, bytes) => {
      media.set(path, bytes);
    },
    generate: (path, size) => {
      generated.set(path, size);
    },
    read: async (path) => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      try {
        readLog.push({ path, writtenAtRead: written, readBefore: readTotal });
        await Promise.resolve();
        if (failingReads.has(path)) throw new Error('Unable to read file');
        const size = generated.get(path);
        const bytes = size === undefined ? media.get(path) : new Uint8Array(size).fill(path.length % 251);
        if (bytes === undefined) throw new Error('File does not exist');
        readTotal += bytes.length;
        return bytes;
      } finally {
        open -= 1;
      }
    },
    writeCacheChunks: async (name, chunks) => {
      const parts: Uint8Array[] = [];
      cache.set(name, new Uint8Array(0));
      for await (const chunk of chunks) {
        written += chunk.length;
        if (failAfter !== null && written > failAfter) {
          cache.delete(name);
          throw new Error('No space left on device');
        }
        if (keep) parts.push(chunk.slice());
        cache.set(name, concat(parts));
      }
      return `file:///cache/${name}`;
    },
    removeCache: (name) => {
      removed.push(name);
      if (removeFails) return Promise.reject(new Error('Unable to delete file'));
      cache.delete(name);
      return Promise.resolve();
    },
    listCache: (): Promise<FileEntry[]> => Promise.resolve([...cache.keys()].map((name) => ({ name, mtimeMs: null }))),
    cacheNames: () => [...cache.keys()],
    cacheBytes: (name) => cache.get(name),
    seedCache: (name, bytes = new Uint8Array([1, 2, 3])) => {
      cache.set(name, bytes);
    },
    writtenBytes: () => written,
    readBytes: () => readTotal,
    reads: () => [...readLog],
    maxConcurrentReads: () => maxOpen,
    removeCalls: () => [...removed],
    failRemoveCache: () => {
      removeFails = true;
    },
    failWriteAfter: (bytes) => {
      failAfter = bytes;
    },
    failReadFor: (path) => {
      failingReads.add(path);
    },
    retain: (value) => {
      keep = value;
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export type ShareMode = 'ok' | 'cancel' | 'error';

export interface FakeSharer extends Sharer {
  mode: ShareMode;
  /** What the share sheet was handed: the uri and the bytes of the file at that moment. */
  calls: { uri: string; bytes: Uint8Array | undefined }[];
  /** Runs while the share sheet is "open", before it answers. */
  during: (() => void | Promise<void>) | null;
}

export function createFakeSharer(files: ExportFiles): FakeSharer {
  const sharer: FakeSharer = {
    mode: 'ok',
    calls: [],
    during: null,
    share: async (uri) => {
      sharer.calls.push({ uri, bytes: files.cacheBytes(uri.slice(uri.lastIndexOf('/') + 1)) });
      await sharer.during?.();
      if (sharer.mode === 'cancel') throw new Error('Share canceled');
      if (sharer.mode === 'error') throw new Error('Activity not found');
    },
  };
  return sharer;
}

export interface ExportWorld {
  db: Db;
  files: ExportFiles;
  clock: ManualClock;
  sharer: FakeSharer;
}

export async function createExportWorld(options: { company?: string | null; account?: Account | null } = {}): Promise<ExportWorld> {
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const files = createExportFiles();
  const account = options.account === undefined ? ALICE : options.account;
  if (account !== null) {
    await saveIdentity(db, { userId: account.userId, tenantId: account.tenantId, role: 'inspector' });
    await db.run("INSERT INTO device_state (key, value) VALUES ('device_id', 'device-1')");
    await db.run("INSERT INTO device_state (key, value) VALUES ('server_url', 'https://oi.example.test')");
    await db.run("INSERT INTO device_state (key, value) VALUES ('client_id:https://oi.example.test', 'CLIENT-ID-FIXTURE')");
    await db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at) VALUES ('tenant-1:alice', '/api/x', 'e', 'cached body DEVICE-KEY-FIXTURE', 1)");
  }
  if (options.company !== null && options.company !== undefined) await db.run("INSERT INTO device_state (key, value) VALUES ('tenant_name', ?)", [options.company]);
  return { db, files, clock: createManualClock(NOW), sharer: createFakeSharer(files) };
}

export interface SeedPhoto {
  pendingId: string;
  type?: 'image/jpeg' | 'image/png' | 'image/heic';
  bytes?: Uint8Array;
  kind?: 'photo' | 'crop' | 'annotate' | 'video';
  state?: string;
}

export interface SeedOptions {
  owner?: Account;
  quarantined?: boolean;
  confirmed?: boolean;
  reportId?: string | null;
  purging?: boolean;
  /** Number of edits stored as Yjs updates. 0 stores none. */
  edits?: number;
  photos?: SeedPhoto[];
  writes?: ('create' | 'update' | 'complete')[];
  /** Overrides the state of every queued write seeded (a quarantined inspection holds them as orphaned). */
  writeState?: 'pending' | 'failed' | 'orphaned';
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic' } as const;
let seq = 0;

/** The JPEG signature followed by filler, so a pass-through entry has recognisable content. */
export function jpegBytes(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size).map((_, i) => (i * 31 + seed) & 0xff);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

export function localDoc(world: ExportWorld, id: string): Promise<Y.Doc> {
  return world.db.query<{ data: Uint8Array }>('SELECT data FROM ydoc_updates WHERE doc_name = ? ORDER BY id', [`results-${id}`]).then((rows) => {
    const doc = new Y.Doc();
    for (const row of rows) Y.applyUpdate(doc, row.data);
    return doc;
  });
}

export async function seedInspection(world: ExportWorld, id: string, options: SeedOptions = {}): Promise<void> {
  const owner = options.owner ?? ALICE;
  const quarantined = options.quarantined === true;
  const reportId = options.reportId === undefined ? `report-${id}` : options.reportId;
  await world.db.run(
    'INSERT INTO work_package (inspection_id, report_id, refreshed_at, quarantine_source, server_confirmed, tenant_id, user_id, purging) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
    [id, reportId, quarantined ? 'reconcile_missing' : null, options.confirmed === false ? 0 : 1, owner.tenantId, owner.userId, options.purging === true ? 1 : 0],
  );

  const edits = options.edits ?? 2;
  if (edits > 0) {
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    for (let i = 0; i < edits; i += 1) doc.getMap<unknown>('results').set(`item-${String(i)}`, { rating: i, note: `note ${id} ${String(i)}` });
    doc.getMap<unknown>('results').set('photo', `pending:${options.photos?.[0]?.pendingId ?? 'none'}`);
    for (const update of updates) await world.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [`results-${id}`, update]);
  }

  for (const photo of options.photos ?? []) {
    const type = photo.type ?? 'image/jpeg';
    const kind = photo.kind ?? 'photo';
    const path = `media/${photo.pendingId}.${kind === 'video' ? 'mp4' : EXT[type]}`;
    world.files.put(path, photo.bytes ?? jpegBytes(64));
    await world.db.run("INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)", [
      photo.pendingId,
      id,
      kind,
      path,
      kind === 'video' ? 'video/mp4' : type,
      photo.state ?? 'pending',
      NOW,
    ]);
  }

  for (const write of options.writes ?? []) {
    seq += 1;
    const state = options.writeState ?? (quarantined ? 'orphaned' : 'pending');
    const payload =
      write === 'create'
        ? { id, propertyAddress: `12 Test Street ${id}`, templateId: 'template-1' }
        : write === 'update'
          ? { inspectionId: id, changes: { propertyAddress: `14 Test Street ${id}` } }
          : { inspectionId: id };
    await world.db.run(
      'INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, registry_version, tenant_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [`key-${id}-${write}-${String(seq)}`, seq, `inspection.${write}`, JSON.stringify(payload), state, NOW, id, owner.tenantId, owner.userId],
    );
  }
}

/** Every table's full contents, so "export changed nothing" is compared on rows and not only on counts. */
export async function snapshotTables(db: Db): Promise<Record<string, string>> {
  const tables = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const rows = await db.query<Record<string, unknown>>(`SELECT * FROM ${name}`);
    out[name] = JSON.stringify(rows, (_key, value: unknown) => (value instanceof Uint8Array ? Array.from(value) : value));
  }
  return out;
}

export async function tableCounts(db: Db): Promise<Record<string, number>> {
  const tables = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out: Record<string, number> = {};
  for (const { name } of tables) out[name] = (await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`))[0]?.n ?? -1;
  return out;
}

export interface ReadPackage {
  entries: Unzipped;
  names: string[];
  manifest: { format: string; version: number; tenantId: string; deviceId: string; exportedBy: string; exportedAt: string; inspections: { id: string; reportId: string }[] };
  outbox: { idempotencyKey: string; op: string; payload: Record<string, unknown> }[];
  media: { pendingId: string; inspectionId: string; contentType: string }[];
}

const decode = (bytes: Uint8Array | undefined): unknown => JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));

/** Reads the cache file the share sheet was given back with `unzipSync`, as the engine's reader would. */
export function readPackage(bytes: Uint8Array): ReadPackage {
  const entries = unzipSync(bytes);
  return {
    entries,
    names: Object.keys(entries),
    manifest: decode(entries['manifest.json']) as ReadPackage['manifest'],
    outbox: decode(entries['outbox.json']) as ReadPackage['outbox'],
    media: decode(entries['media/index.json']) as ReadPackage['media'],
  };
}

export function sharedPackage(world: ExportWorld, call = 0): ReadPackage {
  const bytes = world.sharer.calls[call]?.bytes;
  if (bytes === undefined) throw new Error('Nothing was shared');
  return readPackage(bytes);
}
