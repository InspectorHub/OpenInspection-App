import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { type Db, joinedTransactionHandle, SerialQueue } from './db';

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
  return wrapConnection(conn);
}

/** Thin real-plugin wiring; everything above is unit-tested with fakes. */
export function openRealCapacitorDb(options: OpenCapacitorDbOptions): Promise<Db> {
  return openCapacitorDb(new SQLiteConnection(CapacitorSQLite), options);
}

export function wrapConnection(conn: SqliteDbConnectionLike): Db {
  const queue = new SerialQueue();

  const ops = (inTransaction: boolean): Pick<Db, 'execute' | 'query' | 'run'> => ({
    execute: async (sql) => {
      await conn.execute(sql, inTransaction ? false : undefined);
    },
    query: async <T>(sql: string, params?: unknown[]) => {
      const res = await conn.query(sql, encodeParams(params));
      return (res.values ?? []).map(decodeRow) as T[];
    },
    run: async (sql, params) => {
      const res = await conn.run(sql, encodeParams(params), inTransaction ? false : undefined);
      const lastId = res.changes?.lastId;
      const changes = res.changes?.changes ?? 0;
      return lastId !== undefined && lastId > 0 ? { changes, lastId } : { changes };
    },
  });

  const topLevel = ops(false);
  const inTx = ops(true);

  return {
    execute: (sql) => queue.run(() => topLevel.execute(sql)),
    query: <T>(sql: string, params?: unknown[]) => queue.run(() => topLevel.query<T>(sql, params)),
    run: (sql, params) => queue.run(() => topLevel.run(sql, params)),
    transaction: <T>(fn: (tx: Db) => Promise<T>) =>
      queue.run(async () => {
        await conn.beginTransaction();
        try {
          const out = await fn(joinedTransactionHandle(inTx));
          await conn.commitTransaction();
          return out;
        } catch (err) {
          // Plugin issue #700: a failed run() may roll back a transaction it did
          // not start, so roll back explicitly and ignore "no transaction" noise.
          await conn.rollbackTransaction().catch(() => undefined);
          throw err;
        }
      }),
  };
}

/**
 * BLOB parameters cross the bridge as `{type: 'Buffer', data: number[]}`, the
 * JSON shape of a Node Buffer, which the Android plugin turns into a byte array.
 */
export function encodeParams(params: unknown[] | undefined): unknown[] | undefined {
  if (!params) return undefined;
  return params.map((p) => {
    if (p instanceof Uint8Array) return { type: 'Buffer', data: Array.from(p) };
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
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
