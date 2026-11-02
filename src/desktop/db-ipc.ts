import { createDb, type Db } from '../platform/db';
import { CURRENT_SCHEMA_VERSION, SchemaDriftError, SchemaTooNewError } from '../platform/schema';
import type { DesktopBridge, DbParam, DbRow, OpenReason } from '../../electron/shared/ipc-contract.ts';

export class DesktopOpenError extends Error {
  readonly reason: OpenReason;
  constructor(reason: OpenReason) { super('The desktop database could not be opened'); this.name = 'DesktopOpenError'; this.reason = reason; }
}

export function createDesktopDb(bridge: Pick<DesktopBridge, 'db'>): Db {
  return createAdapter(bridge, null);
}

function createAdapter(bridge: Pick<DesktopBridge, 'db'>, initialOpen: Promise<void> | null): Db {
  let opened = initialOpen;
  const ensureOpen = (): Promise<void> => {
    opened ??= bridge.db.open().then((result) => {
      if (result.ok) return;
      if (result.reason === 'schema-too-new') throw new SchemaTooNewError(CURRENT_SCHEMA_VERSION + 1, CURRENT_SCHEMA_VERSION);
      if (result.reason === 'schema-drift') throw new SchemaDriftError('desktop database shape');
      throw new DesktopOpenError(result.reason);
    });
    return opened;
  };
  return createDb({
    statements: (_inside) => ({
      execute: async (sql) => { await ensureOpen(); await bridge.db.execute(sql); },
      query: async <T>(sql: string, params?: unknown[]) => {
        await ensureOpen();
        const rows = await bridge.db.query(sql, toParams(params));
        return rows.map(decodeRow) as T[];
      },
      run: async (sql, params) => { await ensureOpen(); return bridge.db.run(sql, toParams(params)); },
    }),
    begin: async () => { await ensureOpen(); await bridge.db.begin(); },
    commit: async () => { await bridge.db.commit(); },
    rollback: async () => { await bridge.db.rollback(); },
    hasOpenTransaction: () => bridge.db.inTransaction(),
  });
}

export function openDesktopDbViaBridge(bridge: Pick<DesktopBridge, 'db'>): Promise<Db> {
  return bridge.db.open().then((result) => {
    if (!result.ok) {
      if (result.reason === 'schema-too-new') throw new SchemaTooNewError(CURRENT_SCHEMA_VERSION + 1, CURRENT_SCHEMA_VERSION);
      if (result.reason === 'schema-drift') throw new SchemaDriftError('desktop database shape');
      throw new DesktopOpenError(result.reason);
    }
    return createAdapter(bridge, Promise.resolve());
  });
}

function toParams(params: unknown[] | undefined): DbParam[] {
  return (params ?? []).map((value) => {
    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
    if (value instanceof Uint8Array) return Uint8Array.from(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    throw new TypeError('Unsupported SQL parameter type');
  });
}

function decodeRow(row: DbRow): DbRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? Uint8Array.from(value) : value])) as DbRow;
}
