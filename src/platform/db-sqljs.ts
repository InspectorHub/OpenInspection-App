import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import { createDb, type Db, type DbOptions } from './db';

/**
 * In-memory SQLite (sql.js) implementing `Db`. Used by unit tests so storage
 * logic runs without a device. BLOBs come back as `Uint8Array`.
 */
export async function createSqlJsDb(options?: DbOptions): Promise<Db> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();

  const ops: Pick<Db, 'execute' | 'query' | 'run'> = {
    execute: (sql) => {
      raw.exec(sql);
      return Promise.resolve();
    },
    query: <T>(sql: string, params?: unknown[]) => Promise.resolve(selectRows(raw, sql, params) as T[]),
    run: (sql, params) => {
      raw.run(sql, toSqlValues(params));
      const changes = raw.getRowsModified();
      const lastId = Number(selectRows(raw, 'SELECT last_insert_rowid() AS id')[0]?.id ?? 0);
      return Promise.resolve(lastId > 0 ? { changes, lastId } : { changes });
    },
  };

  return createDb({
    statements: () => ops,
    begin: () => {
      raw.run('BEGIN');
      return Promise.resolve();
    },
    commit: () => {
      raw.run('COMMIT');
      return Promise.resolve();
    },
    rollback: () => {
      raw.run('ROLLBACK');
      return Promise.resolve();
    },
  }, options);
}

function toSqlValues(params: unknown[] | undefined): SqlValue[] {
  return (params ?? []).map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' || typeof p === 'string' || p instanceof Uint8Array) return p;
    throw new Error(`Unsupported SQL parameter type: ${typeof p}`);
  });
}

function selectRows(raw: Database, sql: string, params?: unknown[]): Record<string, unknown>[] {
  const stmt = raw.prepare(sql, toSqlValues(params));
  try {
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}
