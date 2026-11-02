import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { openNativeSqlite } from '../../electron/main/data/db-open';
import { createDbHost, watchRendererDbLifecycle } from '../../electron/main/data/db-host';
import { createSqlJsDb } from '../platform/db-sqljs';
import { describeDbContract } from '../platform/test-support/db-contract';
import { createDesktopDb, openDesktopDbViaBridge } from './db-ipc';

describeDbContract('sql.js', createSqlJsDb);

function bridge() {
  const calls: string[] = [];
  const value: Record<string, unknown> = {};
  let snapshot: Record<string, unknown> | null = null;
  let tx = false;
  const api = {
    open: async (): Promise<{ ok: boolean; schemaVersion?: number; reason?: string }> => ({ ok: true, schemaVersion: 2 }),
    execute: async (sql: string) => { calls.push(sql); if (sql.startsWith('CREATE')) value.table = true; if (sql.startsWith('PRAGMA user_version =')) value.version = Number(sql.split('=').at(-1)); },
    query: async (sql: string) => {
      calls.push(sql);
      if (sql === 'PRAGMA user_version') return [{ user_version: value.version ?? 0 }];
      if (sql.includes('FROM contract_rollback')) return value.rollback ? [{ value: value.rollback }] : [];
      if (sql.includes('FROM contract_nested')) return value.nested ? [{ value: value.nested }] : [];
      if (sql.includes('FROM contract_order')) return value.order === undefined ? [] : [{ value: value.order }];
      if (sql.includes('FROM contract_blob')) return value.blob === undefined ? [] : [{ value: Uint8Array.from(value.blob as Uint8Array) }];
      return [];
    },
    run: async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('contract_rollback')) value.rollback = params?.[0];
      if (sql.includes('contract_nested')) value.nested = params?.[0];
      if (sql.includes('contract_order')) value.order = params?.[0];
      if (sql.includes('contract_blob')) value.blob = Uint8Array.from(params?.[0] as Uint8Array);
      return { changes: 1 };
    },
    begin: async () => { tx = true; snapshot = { ...value, ...(value.blob instanceof Uint8Array ? { blob: Uint8Array.from(value.blob) } : {}) }; calls.push('BEGIN'); },
    commit: async () => { tx = false; calls.push('COMMIT'); },
    rollback: async () => { tx = false; for (const key of Object.keys(value)) delete value[key]; if (snapshot) Object.assign(value, snapshot); snapshot = null; calls.push('ROLLBACK'); },
    inTransaction: async () => tx,
    close: async () => undefined,
    setAsideUnreadable: async () => undefined,
  };
  return { db: api, calls, api, isInTransaction: () => tx };
}

describeDbContract('desktop adapter', async () => createDesktopDb({ db: bridge().db } as never));

describe('desktop Db IPC adapter', () => {
  it('maps open failures to typed errors', async () => {
    const b = bridge();
    b.api.open = async () => ({ ok: false, reason: 'key-unreadable' });
    await expect(openDesktopDbViaBridge({ db: b.db } as never)).rejects.toMatchObject({ reason: 'key-unreadable' });
  });

  it('rolls back when a renderer webContents is destroyed during a transaction', async () => {
    const sqlite = openNativeSqlite(':memory:');
    const host = createDbHost(sqlite);
    host.execute('CREATE TABLE gone_rows (value TEXT NOT NULL)');
    host.begin(); host.run('INSERT INTO gone_rows (value) VALUES (?)', ['uncommitted']);
    const contents = new EventEmitter();
    const rollback = vi.spyOn(host, 'rollback');
    watchRendererDbLifecycle(contents, host);
    contents.emit('destroyed');
    expect(rollback).toHaveBeenCalledOnce();
    expect(host.inTransaction()).toBe(false);
    expect(host.query('SELECT value FROM gone_rows', [])).toEqual([]);
    host.close();
  });
});
