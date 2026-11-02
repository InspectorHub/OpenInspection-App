import type { DbParam, DbRow } from '../../shared/ipc-contract.ts';

export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): { reader: boolean; all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint } };
  pragma(s: string, o?: { simple?: boolean }): unknown;
  key(k: Buffer): void;
  close(): void;
  readonly inTransaction: boolean;
}

export interface DbHost {
  execute(sql: string): void;
  query(sql: string, p: DbParam[]): DbRow[];
  run(sql: string, p: DbParam[]): { changes: number; lastId?: number };
  begin(): void;
  commit(): void;
  rollback(): void;
  inTransaction(): boolean;
  close(): void;
}

/** The one synchronous main-process connection. Renderer calls are serialized by the shared createDb queue. */
export function createDbHost(connection: SqliteConnection): DbHost {
  let transactionOpen = false;
  // All raw operations happen on the Electron main thread. The host's methods are synchronous so IPC invocation
  // cannot yield while a manual transaction is open and let unrelated renderer requests interleave.
  return {
    execute(sql) { connection.exec(sql); },
    query(sql, p = []) { return execute(connection, sql, p, true) as DbRow[]; },
    run(sql, p = []) { return execute(connection, sql, p, false) as { changes: number; lastId?: number }; },
    begin() {
      if (transactionOpen || connection.inTransaction) throw new Error('transaction-already-open');
      connection.exec('BEGIN');
      transactionOpen = true;
    },
    commit() {
      if (!transactionOpen || !connection.inTransaction) throw new Error('transaction-not-open');
      connection.exec('COMMIT');
      transactionOpen = false;
    },
    rollback() {
      if (!transactionOpen && !connection.inTransaction) return;
      connection.exec('ROLLBACK');
      transactionOpen = false;
    },
    inTransaction: () => transactionOpen || connection.inTransaction,
    close() {
      if (transactionOpen || connection.inTransaction) {
        connection.exec('ROLLBACK');
        transactionOpen = false;
      }
      connection.close();
    },
  };
}

function execute(connection: SqliteConnection, sql: string, params: unknown[] | undefined, query: true): DbRow[];
function execute(connection: SqliteConnection, sql: string, params: unknown[] | undefined, query: false): { changes: number; lastId?: number };
function execute(connection: SqliteConnection, sql: string, params: unknown[] | undefined, query: boolean): DbRow[] | { changes: number; lastId?: number } {
  const statement = connection.prepare(sql);
  const bound = (params ?? []).map((value) => value instanceof Uint8Array ? Buffer.from(value) : value === undefined ? null : value);
  if (query || statement.reader) {
    return statement.all(...bound).map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, Buffer.isBuffer(value) ? Uint8Array.from(value) : value]))) as DbRow[];
  }
  const result = statement.run(...bound);
  const lastId = Number(result.lastInsertRowid);
  return lastId > 0 && /^\s*(?:INSERT|REPLACE)\b/i.test(sql) ? { changes: result.changes, lastId } : { changes: result.changes };
}

export function watchRendererDbLifecycle(contents: { on(event: string, listener: () => void): unknown }, host: Pick<DbHost, 'inTransaction' | 'rollback'> | (() => Pick<DbHost, 'inTransaction' | 'rollback'> | null)): void {
  let handled = false;
  const getHost = typeof host === 'function' ? host : () => host;
  const gone = (): void => {
    if (handled) return;
    handled = true;
    const current = getHost();
    if (current?.inTransaction()) current.rollback();
  };
  contents.on('destroyed', gone);
  contents.on('render-process-gone', gone);
}
