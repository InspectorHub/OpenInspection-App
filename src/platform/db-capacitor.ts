import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { createDb, type Db } from './db';

/** The platforms the adapter distinguishes; anything that is not Android or iOS is `web`. */
export type DbPlatform = 'android' | 'ios' | 'web';

export interface DbUpgrade {
  toVersion: number;
  statements: string[];
}

export interface DbChanges {
  changes?: { changes?: number; lastId?: number };
}

/** The subset of `SQLiteDBConnection` the adapter uses. */
export interface SqliteDbConnectionLike {
  open(): Promise<void>;
  execute(statements: string, transaction?: boolean): Promise<DbChanges>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<DbChanges>;
  beginTransaction(): Promise<DbChanges>;
  commitTransaction(): Promise<DbChanges>;
  rollbackTransaction(): Promise<DbChanges>;
  isTransactionActive(): Promise<{ result?: boolean }>;
}

/** The subset of `SQLiteConnection` the adapter uses. */
export interface SqliteConnectionLike {
  isSecretStored(): Promise<{ result?: boolean }>;
  setEncryptionSecret(passphrase: string): Promise<void>;
  checkConnectionsConsistency(): Promise<{ result?: boolean }>;
  isConnection(database: string, readonly: boolean): Promise<{ result?: boolean }>;
  retrieveConnection(database: string, readonly: boolean): Promise<SqliteDbConnectionLike>;
  createConnection(
    database: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<SqliteDbConnectionLike>;
  addUpgradeStatement(database: string, upgrade: DbUpgrade[]): Promise<void>;
}

export interface OpenCapacitorDbOptions {
  name: string;
  /** Latest schema version; must equal the highest `toVersion` in `upgrades`. */
  version: number;
  /** Versioned migration statements, registered before the connection is created. */
  upgrades: DbUpgrade[];
  /** Decides how BLOB parameters are encoded for the plugin's native side. */
  platform: DbPlatform;
  /** Injectable for tests. Defaults to 32 random bytes as hex. */
  generateSecret?: () => string;
}

export function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens (creating on first launch) the encrypted database and returns a `Db`.
 * The plugin manages the encryption key itself; this only provisions it once.
 */
export async function openCapacitorDb(
  sqlite: SqliteConnectionLike,
  options: OpenCapacitorDbOptions,
): Promise<Db> {
  const { name, version, upgrades } = options;

  const stored = await sqlite.isSecretStored();
  if (!stored.result) {
    await sqlite.setEncryptionSecret((options.generateSecret ?? randomHex32)());
  }

  await sqlite.checkConnectionsConsistency();
  if (upgrades.length > 0) {
    await sqlite.addUpgradeStatement(name, upgrades);
  }

  const existing = await sqlite.isConnection(name, false);
  const conn = existing.result
    ? await sqlite.retrieveConnection(name, false)
    : await sqlite.createConnection(name, true, 'secret', version, false);
  await conn.open();
  return wrapConnection(conn, options.platform);
}

/** Thin real-plugin wiring; everything above is unit-tested with fakes. */
export function openRealCapacitorDb(options: Omit<OpenCapacitorDbOptions, 'platform'>): Promise<Db> {
  return openCapacitorDb(new SQLiteConnection(CapacitorSQLite), {
    ...options,
    platform: toDbPlatform(Capacitor.getPlatform()),
  });
}

export function toDbPlatform(platform: string): DbPlatform {
  return platform === 'android' || platform === 'ios' ? platform : 'web';
}

export function wrapConnection(conn: SqliteDbConnectionLike, platform: DbPlatform): Db {
  const ops = (inTransaction: boolean): Pick<Db, 'execute' | 'query' | 'run'> => ({
    execute: async (sql) => {
      await conn.execute(sql, inTransaction ? false : undefined);
    },
    query: async <T>(sql: string, params?: unknown[]) => {
      const res = await conn.query(sql, encodeParams(params, platform));
      return (res.values ?? []).map(decodeRow) as T[];
    },
    run: async (sql, params) => {
      const res = await conn.run(sql, encodeParams(params, platform), inTransaction ? false : undefined);
      const lastId = res.changes?.lastId;
      const changes = res.changes?.changes ?? 0;
      return lastId !== undefined && lastId > 0 ? { changes, lastId } : { changes };
    },
  });

  return createDb({
    statements: ops,
    begin: async () => {
      await conn.beginTransaction();
    },
    commit: async () => {
      await conn.commitTransaction();
    },
    // Plugin issue #700: a failed run() may already have rolled back a
    // transaction it did not start, so a failed rollback only poisons the
    // connection when the plugin still reports a transaction as open.
    rollback: async () => {
      await conn.rollbackTransaction();
    },
    hasOpenTransaction: async () => (await conn.isTransactionActive()).result === true,
  });
}

/**
 * BLOB parameters cross the bridge in a platform-specific shape, taken from the
 * plugin's native sources. Android (UtilsSQLite.java) accepts the JSON of a Node
 * Buffer, `{type: 'Buffer', data: number[]}`. iOS (CapacitorSQLite.swift, `run`)
 * only accepts a dictionary whose every value is an Int, keyed by byte index, and
 * throws "Error in reading buffer" for anything else. On web there is no
 * supported BLOB path in this adapter, so a BLOB parameter throws rather than
 * guessing a shape.
 */
export function encodeParams(params: unknown[] | undefined, platform: DbPlatform): unknown[] | undefined {
  if (!params) return undefined;
  return params.map((p) => {
    if (p instanceof Uint8Array) return encodeBlob(p, platform);
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

function encodeBlob(bytes: Uint8Array, platform: DbPlatform): unknown {
  if (platform === 'android') return { type: 'Buffer', data: Array.from(bytes) };
  if (platform === 'ios') return Object.fromEntries(Array.from(bytes, (byte, index) => [String(index), byte]));
  throw new Error('BLOB parameters are not supported on platform web');
}

/** The plugin returns BLOB columns as plain number arrays. */
export function decodeRow(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = isByteArray(value) ? Uint8Array.from(value) : value;
  }
  return out;
}

function isByteArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
  );
}
