import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { assertSchemaShape, CURRENT_SCHEMA_VERSION, migrate, readSchemaVersion, SchemaDriftError, SchemaTooNewError } from '../../../src/platform/schema.ts';
import { createDb, type Db } from '../../../src/platform/db.ts';
import type { DbRow, DbParam, OpenReason } from '../../shared/ipc-contract.ts';
import type { LogEvent } from '../logger.ts';
import { DB_KEY_NAME } from './reserved-secrets.ts';
import { SecretUnreadableError, type FsLike as SecretsFsLike, type SecretsHost } from './secrets.ts';
import { createDbHost, type DbHost, type SqliteConnection } from './db-host.ts';

export interface DbFsLike extends SecretsFsLike {
  access(path: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<Array<string | { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>>;
  stat(path: string): Promise<{ mtimeMs: number }>;
}

export type DbOpenOutcome = { ok: true; schemaVersion: number } | { ok: false; reason: OpenReason };

const DB_FILE = 'inspectorhub.db';
const HEX_32 = /^[0-9a-f]{64}$/;
const defaultFs = nodeFs as unknown as DbFsLike;

interface NativeStatement {
  readonly reader: boolean;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface NativeDatabase {
  readonly inTransaction: boolean;
  exec(sql: string): this;
  prepare(sql: string): NativeStatement;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  key(key: Buffer): number;
  close(): this;
}

type NativeDatabaseConstructor = new (file: string, options?: { fileMustExist?: boolean }) => NativeDatabase;
const Database = createRequire(__filename)('better-sqlite3-multiple-ciphers') as NativeDatabaseConstructor;

export function openNativeSqlite(file: string): SqliteConnection {
  const database = new Database(file, { fileMustExist: false });
  return {
    exec: (sql) => { database.exec(sql); },
    prepare: (sql) => database.prepare(sql),
    pragma: (sql, options) => database.pragma(sql, options),
    key: (key) => { database.key(key); },
    close: () => { database.close(); },
    get inTransaction() { return database.inTransaction; },
  };
}

export async function openDesktopDb(deps: {
  dbDir: string;
  secrets: SecretsHost;
  open(file: string): SqliteConnection;
  fs?: DbFsLike;
  now(): number;
  log(code: LogEvent): void;
}): Promise<{ outcome: DbOpenOutcome; host: DbHost | null }> {
  const fs = deps.fs ?? defaultFs;
  const file = join(deps.dbDir, DB_FILE);
  let existed = false;
  try { await fs.access(file); existed = true; }
  catch (error) { if (!isMissing(error)) { deps.log('db-exists-check-failed'); return { outcome: { ok: false, reason: 'io' }, host: null }; } }

  if (!deps.secrets.available) return { outcome: { ok: false, reason: 'encryption-unavailable' }, host: null };

  let keyText: string | null;
  try { keyText = await deps.secrets.get(DB_KEY_NAME); }
  catch (error) {
    if (error instanceof SecretUnreadableError) return { outcome: { ok: false, reason: 'key-unreadable' }, host: null };
    deps.log('db-key-read-failed');
    return { outcome: { ok: false, reason: existed ? 'key-unreadable' : 'io' }, host: null };
  }
  if (keyText === null) {
    if (existed) return { outcome: { ok: false, reason: 'key-unreadable' }, host: null };
    keyText = randomBytes(32).toString('hex');
    try { await deps.secrets.set(DB_KEY_NAME, keyText); }
    catch { deps.log('db-key-write-failed'); return { outcome: { ok: false, reason: 'io' }, host: null }; }
  }
  if (!HEX_32.test(keyText)) return { outcome: { ok: false, reason: 'key-unreadable' }, host: null };

  let connection: SqliteConnection | null = null;
  try {
    await fs.mkdir(deps.dbDir, { recursive: true, mode: 0o700 });
    connection = deps.open(file);
    connection.pragma("cipher='sqlcipher'");
    connection.pragma('legacy=4');
    connection.key(Buffer.from(keyText, 'hex'));
    const rawDb = createSyncDb(connection);
    const version = await readSchemaVersion(rawDb);
    if (version > CURRENT_SCHEMA_VERSION) {
      connection.close(); connection = null;
      return { outcome: { ok: false, reason: 'schema-too-new' }, host: null };
    }
    connection.pragma('journal_mode=WAL');
    connection.pragma('synchronous=FULL');
    connection.pragma('foreign_keys=ON');
    if (version === 1) await assertSchemaShape(rawDb);
    if (existed && version < CURRENT_SCHEMA_VERSION) {
      connection.pragma('wal_checkpoint(TRUNCATE)');
      await backupBeforeMigration(fs, deps.dbDir, file, version, deps.now());
    }
    const schemaVersion = await migrate(rawDb, version);
    const host = createDbHost(connection);
    connection = null;
    return { outcome: { ok: true, schemaVersion }, host };
  } catch (error) {
    try { connection?.close(); } catch { /* close best-effort on open failure */ }
    if (error instanceof SchemaTooNewError) return { outcome: { ok: false, reason: 'schema-too-new' }, host: null };
    if (error instanceof SchemaDriftError) return { outcome: { ok: false, reason: 'schema-drift' }, host: null };
    deps.log(error instanceof Error && /file is not a database|not a database|cipher|decrypt|file is encrypted/i.test(error.message) ? 'db-corrupt' : 'db-open-failed');
    return { outcome: { ok: false, reason: error instanceof Error && /file is not a database|not a database|cipher|decrypt|file is encrypted/i.test(error.message) ? 'corrupt' : 'io' }, host: null };
  }
}

/** Move the unreadable database directory out of the active path before replacing its secret. If rotation fails,
 * the directory is already preserved and a retry can finish by writing a key to the now-empty active location. */
export async function setAsideUnreadableDatabase(deps: {
  dbDir: string;
  secrets: SecretsHost;
  fs?: DbFsLike;
  now(): number;
}): Promise<string | null> {
  const fs = deps.fs ?? defaultFs;
  let archive: string | null = null;
  let databaseDirectoryExists = true;
  try {
    await fs.access(deps.dbDir);
  } catch (error) {
    if (!isMissing(error)) throw error;
    databaseDirectoryExists = false;
  }
  if (databaseDirectoryExists) {
    const parent = dirname(deps.dbDir);
    const stamp = new Date(deps.now()).toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const names = await fs.readdir(parent);
    let suffix = 0;
    do {
      archive = join(parent, `unreadable-${stamp}${suffix ? `-${String(suffix)}` : ''}`);
      suffix += 1;
    } while (names.some((name) => typeof name === 'string' && name === basename(archive!)));
    await fs.rename(deps.dbDir, archive);
  }

  // On retry, a missing active directory means an earlier attempt already preserved it before key rotation failed.
  const freshKey = randomBytes(32).toString('hex');
  await deps.secrets.set(DB_KEY_NAME, freshKey);
  return archive;
}

function createSyncDb(connection: SqliteConnection): Db {
  return createDb({
    statements: (_inside) => ({
      execute: async (sql) => { connection.exec(sql); },
      query: async <T>(sql: string, params?: unknown[]) => executeStatement(connection, sql, params, true) as T[],
      run: async (sql: string, params?: unknown[]) => executeStatement(connection, sql, params, false) as { changes: number; lastId?: number },
    }),
    begin: async () => { connection.exec('BEGIN'); },
    commit: async () => { connection.exec('COMMIT'); },
    rollback: async () => { if (connection.inTransaction) connection.exec('ROLLBACK'); },
    hasOpenTransaction: async () => connection.inTransaction,
  });
}

function executeStatement(connection: SqliteConnection, sql: string, params: unknown[] | undefined, query: true): DbRow[];
function executeStatement(connection: SqliteConnection, sql: string, params: unknown[] | undefined, query: false): { changes: number; lastId?: number };
function executeStatement(connection: SqliteConnection, sql: string, params: unknown[] | undefined, query: boolean): DbRow[] | { changes: number; lastId?: number } {
  const statement = connection.prepare(sql);
  const bound = (params ?? []).map((value) => value instanceof Uint8Array ? Buffer.from(value) : value === undefined ? null : value);
  if (query || statement.reader) {
    return statement.all(...bound).map((value) => decodeRow(value as Record<string, unknown>));
  }
  const result = statement.run(...bound);
  const lastId = Number(result.lastInsertRowid);
  return lastId > 0 && /^\s*(?:INSERT|REPLACE)\b/i.test(sql) ? { changes: result.changes, lastId } : { changes: result.changes };
}

function decodeRow(row: Record<string, unknown>): DbRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? Uint8Array.from(value) : value])) as DbRow;
}

async function backupBeforeMigration(fs: DbFsLike, dbDir: string, file: string, version: number, now: number): Promise<void> {
  const backupsDir = join(dbDir, 'backups');
  await fs.mkdir(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const target = join(backupsDir, `inspectorhub-v${String(version)}-${stamp}.db`);
  await fs.copyFile(file, target);
  const existing = (await fs.readdir(backupsDir)).filter((name): name is string => typeof name === 'string' && /^inspectorhub-v\d+-/.test(name));
  const ranked = await Promise.all(existing.map(async (name) => ({ name, mtime: (await fs.stat(join(backupsDir, name))).mtimeMs })));
  ranked.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const stale of ranked.slice(2)) await fs.unlink(join(backupsDir, stale.name));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export type { DbHost, DbParam };
